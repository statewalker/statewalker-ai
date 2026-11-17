# Threat table

The harness's security properties, each with the tests that prove it
(statewalker/statewalker-root#85). A row names its tests as `` `<package>`: "<test title>" ``,
separated by `;`. `ai-conformance`'s threat-table test fails CI when a row names no test or a test
that does not exist. Every ticket that touches a security property adds or extends its row.

| Property | Tests |
|---|---|
| Only access tokens the deployment's issuer signed, for this workspace and not expired, open a user session or reach the session API | `ai-conformance`: "refuses a request whose access token the issuer did not sign"; `ai-conformance`: "refuses an expired access token"; `ai-conformance`: "refuses to start an agent session without a valid access token" |
| Membership: a user not in a project's access file cannot start an agent session there | `ai-conformance`: "refuses to start an agent session for a user not in the project's access file" |
| An agent session's capability never leaves the server | `ai-conformance`: "starts an agent session in a project the user is a member of" |
| An agent reads only inside its session's project, under every path form (absolute, relative, `..`, a sibling sharing the name's prefix), whatever its user's roles elsewhere | `ai-conformance`: "refuses the read tool a file outside the session's project" |
| The project's system folder is not there for an agent (ENOENT under every path form) | `ai-conformance`: "never lets the read tool see the project's system folder" |
| A user reaches only their own agent sessions | `ai-conformance`: "refuses a message to another user's agent session"; `ai-conformance`: "refuses to list another user's agent session" |
