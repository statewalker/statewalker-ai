# Threat table

The harness's security properties, each with the tests that prove it
(statewalker/statewalker-root#85). A row names its tests as `` `<package>`: "<test title>" ``,
separated by `;`. `ai-conformance`'s threat-table test fails CI when a row names no test or a test
that does not exist. Every ticket that touches a security property adds or extends its row.

| Property | Tests |
|---|---|
| Only access tokens the deployment's issuer signed, for this workspace and not expired, open a user session or reach the session API | `ai-conformance`: "refuses a request whose access token the issuer did not sign"; `ai-conformance`: "refuses an expired access token"; `ai-conformance`: "refuses to start an agent session without a valid access token" |
| Membership: a user not in a project's access file cannot start an agent session there | `ai-conformance`: "refuses to start an agent session for a user not in the project's access file" |
| The workspace root key and every capability (user and agent session) stay on the server | `ai-conformance`: "lists the caller's agent sessions in the token's workspace, from the session index"; `ai-conformance`: "starts an agent session in a project the user is a member of" |
| An agent reads only inside its session's project, under every path form (absolute, relative, `..`, a sibling sharing the name's prefix), whatever its user's roles elsewhere | `ai-conformance`: "refuses the read tool a file outside the session's project" |
| The project's system folder is not there for an agent (ENOENT under every path form) | `ai-conformance`: "never lets the read tool see the project's system folder" |
| A user reaches only their own agent sessions | `ai-conformance`: "refuses a message to another user's agent session"; `ai-conformance`: "refuses to list another user's agent session" |
| Tenancy: a Workspace DO never calls a User DO; the gate takes user, project and session from the capability alone and answers while the User DO is unreachable | `ai-conformance`: "the gate answers an agent session's file calls while its User DO is unreachable"; `ai-conformance`: "a Workspace DO holds no way to call a User DO or the profiles" |
| One user's User DO never reaches another user's profile or sessions; a user name cannot place a profile outside `profiles/<user>/` | `ai-conformance`: "serves each user only their own folder of the profiles file system"; `ai-conformance`: "refuses a user whose name would reach outside their own profile folder"; `ai-conformance`: "refuses to list another user's agent session"; `ai-environment`: "never reaches another user's profile, under any path form"; `ai-environment`: "refuses a user name that is not one path segment"; `ai-access`: "mints no capability for a user name that is not one path segment" |
| A session is reached only with a token for its own workspace, and a token for a workspace the deployment does not serve is refused | `ai-conformance`: "lists another workspace's sessions only with a token for that workspace"; `ai-conformance`: "refuses a token for a workspace the deployment does not serve" |
| Attenuation only narrows: an agent session's capability cannot be moved to another project or session by a later block, and a bare user capability or another workspace's never passes the gate | `ai-access`: "an agent session's capability cannot be widened to another project by a later block"; `ai-access`: "refuses at the gate a bare user capability and one another workspace signed" |
| Erasing a user erases their profile and their User DO's storage, and no other user's | `ai-conformance`: "erasing a user erases their profile and their User DO's storage" |
