// The session API (statewalker/statewalker-root#83), implemented once as methods. REST
// (./rest.ts) and RPC (./rpc.ts) are thin routers onto these methods; every call is made with the
// caller's access token, checked by the Workspace DO each time.

export interface UserSessionView {
  id: string;
  user: string;
  workspace: string;
  created: number;
}

/** The session API, as one caller (one access token) sees it. */
export interface SessionApi {
  /** Opens the caller's user session in the workspace, or resumes it. */
  me(): Promise<UserSessionView>;
}

/** The Workspace DO's side of the API: everything that needs the token checked. */
export interface WorkspacePort {
  openUserSession(token: string): Promise<UserSessionView>;
}

export interface SessionApiPorts {
  workspace: WorkspacePort;
}

export function createSessionApi(token: string, ports: SessionApiPorts): SessionApi {
  return {
    me: () => ports.workspace.openUserSession(token),
  };
}
