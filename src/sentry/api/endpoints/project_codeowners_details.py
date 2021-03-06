import logging

from rest_framework import status
from rest_framework.response import Response
from sentry.api.bases.project import ProjectEndpoint
from sentry.api.serializers import serialize
from sentry.models import ProjectCodeOwners
from sentry.api.exceptions import ResourceDoesNotExist

from .project_codeowners import ProjectCodeOwnerSerializer

from sentry.api.endpoints.project_ownership import ProjectOwnershipMixin

logger = logging.getLogger(__name__)


class ProjectCodeOwnersDetailsEndpoint(ProjectEndpoint, ProjectOwnershipMixin):
    def convert_args(
        self, request, organization_slug, project_slug, codeowners_id, *args, **kwargs
    ):
        args, kwargs = super().convert_args(
            request, organization_slug, project_slug, *args, **kwargs
        )
        try:
            kwargs["codeowners"] = ProjectCodeOwners.objects.get(
                id=codeowners_id, project=kwargs["project"]
            )
        except ProjectCodeOwners.DoesNotExist:
            raise ResourceDoesNotExist

        return (args, kwargs)

    def put(self, request, project, codeowners):
        """
        Update a CodeOwners
        `````````````

        :pparam string organization_slug: the slug of the organization.
        :pparam string project_slug: the slug of the project to get.
        :pparam string codeowners_id: id of codeowners object
        :param string raw: the raw CODEOWNERS text
        :param string codeMappingId: id of the RepositoryProjectPathConfig object
        :auth: required
        """
        serializer = ProjectCodeOwnerSerializer(
            instance=codeowners,
            context={"ownership": self.get_ownership(project), "project": project},
            partial=True,
            data={**request.data},
        )
        if serializer.is_valid():
            updated_codeowners = serializer.save()

            return Response(serialize(updated_codeowners, request.user), status=status.HTTP_200_OK)

        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, project, codeowners):
        """
        Delete a CodeOwners
        """

        codeowners.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
