declare module "@statewalker/fsm" {
  export interface FsmStateConfig {
    key: string;
    transitions?: [from: string, event: string, to: string][];
    states?: FsmStateConfig[];
    [key: string]: unknown;
  }

  export interface FsmStateDump {
    key: string;
    data: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface FsmProcessDump {
    status: number;
    event?: string;
    stack: FsmStateDump[];
    [key: string]: unknown;
  }

  export class FsmState {
    key: string;
    process: FsmProcess;
    parent?: FsmState;
    onEnter(handler: (state: FsmState) => void | Promise<void>): () => void;
    onExit(handler: (state: FsmState) => void | Promise<void>): () => void;
    dump(
      handler: (state: FsmState, data: Record<string, unknown>) => void,
    ): () => void;
    restore(
      handler: (state: FsmState, data: Record<string, unknown>) => void,
    ): () => void;
    setData<T>(key: string, value: T): this;
    getData<T>(key: string): T | undefined;
  }

  export class FsmProcess {
    state?: FsmState;
    running: boolean;
    status: number;
    config: FsmStateConfig;

    constructor(config: FsmStateConfig);
    dispatch(event: string): Promise<boolean>;
    shutdown(event?: string): Promise<void>;
    dump(...args: unknown[]): Promise<FsmProcessDump>;
    restore(dump: FsmProcessDump, ...args: unknown[]): Promise<this>;
    onStateCreate(
      handler: (state: FsmState) => void | Promise<void>,
    ): () => void;
    onStateError(
      handler: (state: FsmState, error: unknown) => void,
    ): () => void;
  }
}
