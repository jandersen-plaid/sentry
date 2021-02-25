import React from 'react';
import styled from '@emotion/styled';
import * as Sentry from '@sentry/react';
import {Location} from 'history';

import {Client} from 'app/api';
import ErrorBoundary from 'app/components/errorBoundary';
import EventContexts from 'app/components/events/contexts';
import EventContextSummary from 'app/components/events/contextSummary/contextSummary';
import EventDevice from 'app/components/events/device';
import EventErrors, {Error} from 'app/components/events/errors';
import EventAttachments from 'app/components/events/eventAttachments';
import EventCause from 'app/components/events/eventCause';
import EventCauseEmpty from 'app/components/events/eventCauseEmpty';
import EventDataSection from 'app/components/events/eventDataSection';
import EventExtraData from 'app/components/events/eventExtraData/eventExtraData';
import EventSdk from 'app/components/events/eventSdk';
import EventTags from 'app/components/events/eventTags/eventTags';
import EventGroupingInfo from 'app/components/events/groupingInfo';
import EventPackageData from 'app/components/events/packageData';
import RRWebIntegration from 'app/components/events/rrwebIntegration';
import EventSdkUpdates from 'app/components/events/sdkUpdates';
import {DataSection} from 'app/components/events/styles';
import EventUserFeedback from 'app/components/events/userFeedback';
import ExternalLink from 'app/components/links/externalLink';
import {t, tct} from 'app/locale';
import space from 'app/styles/space';
import {
  ExceptionValue,
  Group,
  Organization,
  Project,
  SharedViewOrganization,
} from 'app/types';
import {DebugFile} from 'app/types/debugFiles';
import {Image} from 'app/types/debugImage';
import {Entry, EntryType, Event} from 'app/types/event';
import {Thread} from 'app/types/events';
import {isNotSharedOrganization} from 'app/types/utils';
import {objectIsEmpty} from 'app/utils';
import {analytics} from 'app/utils/analytics';
import withApi from 'app/utils/withApi';
import withOrganization from 'app/utils/withOrganization';
import {projectProcessingIssuesMessages} from 'app/views/settings/project/projectProcessingIssues';

import findBestThread from './interfaces/threads/threadSelector/findBestThread';
import getThreadException from './interfaces/threads/threadSelector/getThreadException';
import EventEntry from './eventEntry';

const MATCH_MINIFIED_DATA_REGEX = /^(\w|\w{2}\.\w{1,2}|\w{3}((\.\w)|(\.\w{2}){2}))(\.|$)/g;

const defaultProps = {
  isShare: false,
  showExampleCommit: false,
  showTagSummary: true,
};

type ProGuardErrors = Array<Error>;

type Props = {
  /**
   * The organization can be the shared view on a public issue view.
   */
  organization: Organization | SharedViewOrganization;
  event: Event;
  project: Project;
  location: Location;
  api: Client;
  group?: Group;
  className?: string;
} & typeof defaultProps;

type State = {
  isLoading: boolean;
  proGuardErrors: ProGuardErrors;
};

class EventEntries extends React.Component<Props, State> {
  static defaultProps = defaultProps;

  state: State = {
    isLoading: true,
    proGuardErrors: [],
  };

  componentDidMount() {
    this.checkProGuardError();
    this.recordIssueError();
  }

  shouldComponentUpdate(nextProps: Props) {
    const {event, showExampleCommit} = this.props;

    return (
      (event && nextProps.event && event.id !== nextProps.event.id) ||
      showExampleCommit !== nextProps.showExampleCommit
    );
  }

  async fetchDebugFile(query: string): Promise<undefined | Array<DebugFile>> {
    const {api, organization, project} = this.props;
    try {
      const debugFiles = await api.requestPromise(
        `/projects/${organization.slug}/${project.slug}/files/dsyms/`,
        {
          method: 'GET',
          query: {
            query,
            file_formats: organization.features?.includes('android-mappings')
              ? ['breakpad', 'macho', 'elf', 'pe', 'pdb', 'sourcebundle']
              : undefined,
          },
        }
      );
      return debugFiles;
    } catch (error) {
      Sentry.captureException(error);
      // do nothing, the UI will not display extra error details
      return undefined;
    }
  }

  isDataMinified(str: string | null) {
    if (!str) {
      return false;
    }

    return !![...str.matchAll(MATCH_MINIFIED_DATA_REGEX)].length;
  }

  hasThreadOrExceptionMinifiedFrameData(event: Event, bestThread?: Thread) {
    if (!bestThread) {
      const exceptionValues: Array<ExceptionValue> =
        event.entries.find(e => e.type === EntryType.EXCEPTION)?.data?.values ?? [];

      return !!exceptionValues.find(exceptionValue =>
        exceptionValue.stacktrace?.frames?.find(frame =>
          this.isDataMinified(frame.module)
        )
      );
    }

    const threadExceptionValues = getThreadException(event, bestThread)?.values ?? [];

    return !!(threadExceptionValues
      ? threadExceptionValues.find(threadExceptionValue =>
          threadExceptionValue.stacktrace?.frames?.find(frame =>
            this.isDataMinified(frame.module)
          )
        )
      : bestThread?.stacktrace?.frames?.find(frame => this.isDataMinified(frame.module)));
  }

  async checkProGuardError() {
    const {event} = this.props;

    if (!event) {
      return;
    }

    const hasEventErrorsProGuardMissingMapping = event.errors?.find(
      error => error.type === 'proguard_missing_mapping'
    );

    if (hasEventErrorsProGuardMissingMapping) {
      this.setState({isLoading: false});
      return;
    }

    const proGuardErrors: ProGuardErrors = [];

    const debugImages = event.entries.find(e => e.type === EntryType.DEBUGMETA)?.data
      .images as undefined | Array<Image>;

    // When debugImages contains a 'proguard' entry, it must always be only one entry
    const proGuardImage = debugImages?.find(
      debugImage => debugImage.type === 'proguard' && !!debugImage.uuid
    );

    // If an entry is of type 'proguard' and has 'uuid',
    // it means that the Sentry Gradle plugin has been executed,
    // otherwise the proguard id wouldn't be in the event.
    // But maybe it failed to upload the mappings file
    if (proGuardImage?.uuid) {
      const debugFile = await this.fetchDebugFile(proGuardImage.uuid);

      if (!debugFile || !debugFile.length) {
        proGuardErrors.push({
          type: 'proguard_missing_mapping',
          message: projectProcessingIssuesMessages.proguard_missing_mapping,
          data: {mapping_uuid: proGuardImage.uuid},
        });
      }

      this.setState({proGuardErrors, isLoading: false});
      return;
    }

    const threads: Array<Thread> =
      event.entries.find(e => e.type === EntryType.THREADS)?.data?.values ?? [];

    const bestThread = findBestThread(threads);
    const hasThreadOrExceptionMinifiedData = this.hasThreadOrExceptionMinifiedFrameData(
      event,
      bestThread
    );

    if (hasThreadOrExceptionMinifiedData) {
      proGuardErrors.push({
        type: 'proguard_incorrectly_configured_plugin',
        message: tct('It seems that the [plugin] was not correctly configured.', {
          plugin: (
            <ExternalLink href="https://docs.sentry.io/platforms/android/proguard/#gradle">
              Sentry Gradle Plugin
            </ExternalLink>
          ),
        }),
      });
    }

    this.setState({proGuardErrors, isLoading: false});
  }

  recordIssueError() {
    const {organization, project, event} = this.props;

    if (!event || !event.errors || !(event.errors.length > 0)) {
      return;
    }

    const errors = event.errors;
    const errorTypes = errors.map(errorEntries => errorEntries.type);
    const errorMessages = errors.map(errorEntries => errorEntries.message);

    const orgId = organization.id;
    const platform = project.platform;

    analytics('issue_error_banner.viewed', {
      org_id: orgId ? parseInt(orgId, 10) : null,
      group: event?.groupID,
      error_type: errorTypes,
      error_message: errorMessages,
      ...(platform && {platform}),
    });
  }

  renderEntries() {
    const {event, project, organization, isShare} = this.props;

    const entries = event?.entries;

    if (!Array.isArray(entries)) {
      return null;
    }

    return (entries as Array<Entry>).map((entry, entryIdx) => (
      <ErrorBoundary
        key={`entry-${entryIdx}`}
        customComponent={
          <EventDataSection type={entry.type} title={entry.type}>
            <p>{t('There was an error rendering this data.')}</p>
          </EventDataSection>
        }
      >
        <EventEntry
          projectSlug={project.slug}
          organization={organization}
          event={event}
          entry={entry}
          isShare={isShare}
        />
      </ErrorBoundary>
    ));
  }

  render() {
    const {
      className,
      organization,
      group,
      isShare,
      project,
      event,
      showExampleCommit,
      showTagSummary,
      location,
    } = this.props;
    const {proGuardErrors, isLoading} = this.state;

    const features = new Set(organization?.features);
    const hasQueryFeature = features.has('discover-query');

    if (!event) {
      return (
        <div style={{padding: '15px 30px'}}>
          <h3>{t('Latest Event Not Available')}</h3>
        </div>
      );
    }

    const hasContext = !objectIsEmpty(event.user) || !objectIsEmpty(event.contexts);
    const hasErrors = !objectIsEmpty(event.errors) || proGuardErrors.length > 1;

    return (
      <div className={className} data-test-id="event-entries">
        {hasErrors && !isLoading && (
          <EventErrors
            event={event}
            orgSlug={organization.slug}
            projectSlug={project.slug}
            proGuardErrors={proGuardErrors}
          />
        )}
        {!isShare &&
          isNotSharedOrganization(organization) &&
          (showExampleCommit ? (
            <EventCauseEmpty organization={organization} project={project} />
          ) : (
            <EventCause
              organization={organization}
              project={project}
              event={event}
              group={group}
            />
          ))}
        {event?.userReport && group && (
          <StyledEventUserFeedback
            report={event.userReport}
            orgId={organization.slug}
            issueId={group.id}
            includeBorder={!hasErrors}
          />
        )}
        {hasContext && showTagSummary && <EventContextSummary event={event} />}
        {showTagSummary && (
          <EventTags
            event={event}
            organization={organization as Organization}
            projectId={project.slug}
            location={location}
            hasQueryFeature={hasQueryFeature}
          />
        )}
        {this.renderEntries()}
        {hasContext && <EventContexts group={group} event={event} />}
        {event && !objectIsEmpty(event.context) && <EventExtraData event={event} />}
        {event && !objectIsEmpty(event.packages) && <EventPackageData event={event} />}
        {event && !objectIsEmpty(event.device) && <EventDevice event={event} />}
        {!isShare && features.has('event-attachments') && (
          <EventAttachments
            event={event}
            orgId={organization.slug}
            projectId={project.slug}
            location={location}
          />
        )}
        {event?.sdk && !objectIsEmpty(event.sdk) && <EventSdk sdk={event.sdk} />}
        {!isShare && event?.sdkUpdates && event.sdkUpdates.length > 0 && (
          <EventSdkUpdates event={{sdkUpdates: event.sdkUpdates, ...event}} />
        )}
        {!isShare && event?.groupID && (
          <EventGroupingInfo
            projectId={project.slug}
            event={event}
            showGroupingConfig={features.has('set-grouping-config')}
          />
        )}
        {!isShare && features.has('event-attachments') && (
          <RRWebIntegration
            event={event}
            orgId={organization.slug}
            projectId={project.slug}
          />
        )}
      </div>
    );
  }
}

const ErrorContainer = styled('div')`
  /*
  Remove border on adjacent context summary box.
  Once that component uses emotion this will be harder.
  */
  & + .context-summary {
    border-top: none;
  }
`;

const BorderlessEventEntries = styled(EventEntries)`
  & ${/* sc-selector */ DataSection} {
    padding: ${space(3)} 0 0 0;
  }
  & ${/* sc-selector */ DataSection}:first-child {
    padding-top: 0;
    border-top: 0;
  }
  & ${/* sc-selector */ ErrorContainer} {
    margin-bottom: ${space(2)};
  }
`;

type StyledEventUserFeedbackProps = {
  includeBorder: boolean;
};

const StyledEventUserFeedback = styled(EventUserFeedback)<StyledEventUserFeedbackProps>`
  border-radius: 0;
  box-shadow: none;
  padding: 20px 30px 0 40px;
  border: 0;
  ${p => (p.includeBorder ? `border-top: 1px solid ${p.theme.innerBorder};` : '')}
  margin: 0;
`;

// TODO(ts): any required due to our use of SharedViewOrganization
export default withOrganization<any>(withApi(EventEntries));
export {BorderlessEventEntries};
