import {
  DomainError,
  RuntimeError,
  Singleton,
  is_node,
  sleep_until,
} from "tstl";

import { Communicator } from "../../components/Communicator";
import { Invoke } from "../../components/Invoke";
import { IHeaderWrapper } from "../internal/IHeaderWrapper";
import { IServer } from "../internal/IServer";
import { once } from "../internal/once";
import { IWorkerSystem } from "./internal/IWorkerSystem";
import { ProcessChannel } from "./internal/processes/ProcessChannel";
import { ThreadPort } from "./internal/threads/ThreadPort";

/**
 * Worker Server.
 *
 * The `WorkerServer` is a class representing a `Worker` server who can communicate with
 * remote client, parent and creator of the `Worker` (anyway {@link WorkerConnector}), using
 * RFC (Remote Function Call).
 *
 * Unlike other servers, `WorkerServer` can accept only a client ({@link WorkerConnector})
 * because the worker is dependent on its parent instance (web page, node or parent worker).
 * Thus, `WorkerServer` does not have any acceptor and communicates with client (its parent)
 * by itself.
 *
 * To start communication with the remote client, call the {@link open}() method with special
 * `Provider`. After your business, don't forget terminating this worker using {@link close}()
 * or {@link WorkerConnector.close}() method. If you don't terminate it, then vulnerable
 * memory and communication channel would be kept and it may cause the memory leak.
 *
 * Also, when declaring this {@link WorkerServer} type, you've to define two template arguments,
 * *Header* and *Provider*. The *Header* type repersents an initial data gotten from the remote
 * system after the connection.
 *
 * The second template argument *Provider* represents the features provided for the remote system.
 * If you don't have any plan to provide any feature to the remote system, just declare it as
 * `null`.
 *
 * @template Header Type of header containing initialization data like activation.
 * @template Provider Type of features provided for remote system.
 * @author Jeongho Nam - https://github.com/samchon
 */
export class WorkerServer<Header, Provider extends object | null>
  extends Communicator<Provider | undefined>
  implements IWorkerSystem, IServer<WorkerServer.State>
{
  /**
   * @hidden
   */
  private channel_: Singleton<Promise<IFeature>>;

  /**
   * @hidden
   */
  private state_: WorkerServer.State;

  /**
   * @hidden
   */
  private header_: Singleton<Promise<Header>>;

  /* ----------------------------------------------------------------
    CONSTRUCTOR
  ---------------------------------------------------------------- */
  /**
   * Default Constructor.
   *
   * @param type You can specify the worker mode when NodeJS. Default is "thread".
   */
  public constructor() {
    super(undefined);
    this.channel_ = new Singleton(async () => {
      // BROWSER CASE
      if (is_node() === false) return (<any>self) as IFeature;

      return (await ThreadPort.isWorkerThread())
        ? ((await ThreadPort()) as IFeature)
        : (ProcessChannel as IFeature);
    });
    this.state_ = WorkerServer.State.NONE;
    this.header_ = new Singleton(async () => {
      (await this.channel_.get()).postMessage(WorkerServer.State.OPENING);

      const data: string = await this._Handshake("getHeader");
      const wrapper: IHeaderWrapper<Header> = JSON.parse(data);
      return wrapper.header;
    });
  }

  /**
   * Open server with `Provider`.
   *
   * Open worker server and start communication with the remote system
   * ({@link WorkerConnector}).
   *
   * Note that, after your business, you should terminate this worker to prevent waste
   * of memory leak. Close this worker by yourself ({@link close}) or let remote client to
   * close this worker ({@link WorkerConnector.close}).
   *
   * @param provider An object providing featrues for the remote system.
   */
  public async open(provider: Provider): Promise<void> {
    // TEST CONDITION
    if (is_node() === false) {
      if (self.document !== undefined)
        throw new DomainError(
          "Error on WorkerServer.open(): this is not Worker.",
        );
    } else if ((await this.channel_.get()).is_worker_server() === false)
      throw new DomainError(
        "Error on WorkerServer.open(): this is not Worker.",
      );
    else if (this.state_ !== WorkerServer.State.NONE)
      throw new DomainError(
        "Error on WorkerServer.open(): the server has been opened yet.",
      );

    // OPEN WORKER
    this.state_ = WorkerServer.State.OPENING;
    this.provider_ = provider;

    // GET HEADERS
    await this.header_.get();

    // SUCCESS
    const channel = await this.channel_.get();
    channel.onmessage = (evt) => this._Handle_message(evt);
    channel.postMessage(WorkerServer.State.OPEN);

    this.state_ = WorkerServer.State.OPEN;
  }

  /**
   * @inheritDoc
   */
  public async close(): Promise<void> {
    // TEST CONDITION
    const error: Error | null = this.inspectReady();
    if (error) throw error;

    //----
    // CLOSE WORKER
    //----
    this.state_ = WorkerServer.State.CLOSING;
    {
      // HANDLERS
      await this.destructor();

      // DO CLOSE
      setTimeout(async () => {
        const channel = await this.channel_.get();
        channel.postMessage(WorkerServer.State.CLOSING);
        channel.close();
      });
    }
    this.state_ = WorkerServer.State.CLOSED;
  }

  /* ----------------------------------------------------------------
    ACCESSORS
  ---------------------------------------------------------------- */
  /**
   * @inheritDoc
   */
  public get state(): WorkerServer.State {
    return this.state_;
  }

  /**
   * Get header containing initialization data like activation.
   */
  public getHeader(): Promise<Header> {
    return this.header_.get();
  }

  /**
   * @hidden
   */
  private _Handshake(
    method: string,
    timeout?: number,
    until?: Date,
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      /* eslint-disable */
      let completed: boolean = false;

      /* eslint-disable */
      let expired: boolean = false;

      if (until !== undefined)
        sleep_until(until)
          .then(() => {
            if (completed === false) {
              reject(
                new DomainError(
                  `Error on WorkerConnector.${method}(): target worker is not sending handshake data over ${timeout} milliseconds.`,
                ),
              );
              expired = true;
            }
          })
          .catch(() => {});

      (await this.channel_.get()).onmessage = once((evt) => {
        if (expired === false) {
          completed = true;
          resolve(evt.data);
        }
      });
    });
  }

  /* ----------------------------------------------------------------
    COMMUNICATOR
  ---------------------------------------------------------------- */
  /**
   * @hidden
   */
  protected async sendData(invoke: Invoke): Promise<void> {
    (await this.channel_.get()).postMessage(JSON.stringify(invoke));
  }

  /**
   * @hidden
   */
  protected inspectReady(): Error | null {
    // NO ERROR
    if (this.state_ === WorkerServer.State.OPEN) return null;
    // ERROR, ONE OF THEM
    else if (this.state_ === WorkerServer.State.NONE)
      return new DomainError("Server is not opened yet.");
    else if (this.state_ === WorkerServer.State.OPENING)
      return new DomainError("Server is on opening; wait for a sec.");
    else if (this.state_ === WorkerServer.State.CLOSING)
      return new RuntimeError("Server is on closing.");
    // MAY NOT BE OCCURED
    else if (this.state_ === WorkerServer.State.CLOSED)
      return new RuntimeError("The server has been closed.");
    else return new RuntimeError("Unknown error, but not connected.");
  }

  /**
   * @hidden
   */
  private _Handle_message(evt: MessageEvent): void {
    if (evt.data === WorkerServer.State.CLOSING) this.close();
    else this.replyData(JSON.parse(evt.data));
  }
}

/**
 *
 */
export namespace WorkerServer {
  /**
   * Current state of the {@link WorkerServer}.
   */
  export import State = IServer.State;
}

//----
// POLYFILL
//----
/**
 * @hidden
 */
interface IFeature {
  close(): void;
  postMessage(message: any): void;
  onmessage(event: MessageEvent): void;
  is_worker_server(): boolean;
}
