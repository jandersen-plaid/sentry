import logging

from sentry.integrations.client import ApiClient
from sentry.shared_integrations.exceptions import ApiError
from sentry.utils.http import absolute_uri

logger = logging.getLogger("sentry.integrations.vercel.api")


class VercelClient(ApiClient):

    base_url = "https://api.vercel.com"
    integration_name = "vercel"

    TEAMS_URL = "/v1/teams/%s"
    USER_URL = "/www/user"
    PROJECT_URL = "/v1/projects/%s"
    PROJECTS_URL = "/v4/projects/"
    WEBHOOK_URL = "/v1/integrations/webhooks"
    ENV_VAR_URL = "/v6/projects/%s/env"
    GET_ENV_VAR_URL = "/v6/projects/%s/env"
    SECRETS_URL = "/v2/now/secrets"
    UPDATE_ENV_VAR_URL = "/v6/projects/%s/env/%s"

    def __init__(self, access_token, team_id=None):
        super().__init__()
        self.access_token = access_token
        self.team_id = team_id

    def request(self, method, path, data=None, params=None, allow_text=False):
        if self.team_id:
            # always need to use the team_id as a param for requests
            params = params or {}
            params["teamId"] = self.team_id
        headers = {"Authorization": f"Bearer {self.access_token}"}
        try:
            return self._request(
                method, path, headers=headers, data=data, params=params, allow_text=allow_text
            )
        except ApiError as e:
            if not e.code == 402:
                raise e

    def get_team(self):
        assert self.team_id
        return self.get(self.TEAMS_URL % self.team_id)

    def get_user(self):
        return self.get(self.USER_URL)["user"]

    def paginate(self, url, type):
        limit = 20
        params = {"limit": limit}
        results = []
        # no one should have more than 200 results
        for i in range(10):
            resp = self.get(url, params=params)
            results += resp[type]
            # if we have less results than the limit, we are done
            if resp["pagination"]["count"] < limit:
                return results
            # continue pagination by setting the until parameter
            params = params.copy()
            params["until"] = resp["pagination"]["next"]
        # log the warning if this happens so we can look into solutions
        logger.warn("Did not finish pagination", extra={"team_id": self.team_id, "url": url})
        return results

    def get_projects(self):
        return self.paginate(self.PROJECTS_URL, "projects")

    def get_project(self, vercel_project_id):
        return self.get(self.PROJECT_URL % vercel_project_id)

    def create_deploy_webhook(self):
        data = {
            "name": "Sentry webhook",
            "url": absolute_uri("/extensions/vercel/webhook/"),
            "events": ["deployment"],
        }
        response = self.post(self.WEBHOOK_URL, data=data)
        return response

    def get_env_vars(self, vercel_project_id):
        return self.get(self.GET_ENV_VAR_URL % vercel_project_id)

    def create_secret(self, name, value):
        data = {"name": name, "value": value}
        response = self.post(self.SECRETS_URL, data=data)["uid"]
        return response

    def create_env_variable(self, vercel_project_id, data):
        return self.post(self.ENV_VAR_URL % vercel_project_id, data=data)

    def update_env_variable(self, vercel_project_id, env_var_id, data):
        return self.patch(self.UPDATE_ENV_VAR_URL % (vercel_project_id, env_var_id), data=data)
