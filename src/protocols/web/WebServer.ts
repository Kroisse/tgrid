/** 
 * @packageDocumentation
 * @module tgrid.protocols.web
 */
//----------------------------------------------------------------
import type __http from "http";
import type __https from "https";
import type __net from "net";
import type __WebSocket from "ws";
import { is_node } from "tstl/utility/node";

const http: typeof __http = is_node() ? require("http") : null!;
const https: typeof __https = is_node() ? require("https") : null!;
const WebSocket: typeof __WebSocket = is_node() ? require("ws") : null!;

import { WebAcceptor } from "./WebAcceptor";
import { IServer } from "../internal/IServer";

import { IHeaderWrapper } from "../internal/IHeaderWrapper";
import { DomainError } from "tstl/exception/DomainError";
import { RuntimeError } from "tstl/exception/RuntimeError";

/**
 * Web Socket Server.
 * 
 *  - available only in the NodeJS.
 * 
 * The `WebServer` is a class who can open an websocket server. Clients connecting to the 
 * `WebServer` would communicate with this server through {@link WebAcceptor} objects using 
 * RFC (Remote Function Call).
 * 
 * To open the websocket server, call the {@link open}() method with your callback function which 
 * would be called whenever a {@link WebAcceptor} has been newly created ay a client's connection.
 * 
 * Also, when declaring this {@link WebServer} type, you've to define two template arguments,
 * *Header* and *Provider*. The *Header* type repersents an initial data gotten from the remote
 * client after the connection. I hope you and client not to omit it and utilize it as an 
 * activation tool to enhance security. 
 * 
 * The second template argument *Provider* represents the features provided for the remote client. 
 * If you don't have any plan to provide any feature to the remote client, just declare it as 
 * `null`.
 * 
 * @template Header Type of header containing initialization data like activation.
 * @template Provider Type of features provided for the remote systems.
 * @author Jeongho Nam - https://github.com/samchon
 */
export class WebServer<Header, Provider extends object | null>
    implements IServer<WebServer.State>
{
    /**
     * @hidden
     */
    private state_: WebServer.State;

    /**
     * @hidden
     */
    private options_?: __https.ServerOptions;

    /**
     * @hidden
     */
    private server_: __http.Server | __https.Server;

    /**
     * @hidden
     */
    private protocol_: __WebSocket.Server;

    /* ----------------------------------------------------------------
        CONSTRUCTORS
    ---------------------------------------------------------------- */
    /**
     * Default Constructor for the `ws` server..
     * 
     * Create an websocket server (`ws://`).
     */
    public constructor();

    /**
     * Initializer Constructor for the `wss` server.
     * 
     * Create a secured websocket server (`wss://`).
     * 
     * @param key Key string.
     * @param cert Certification string.
     */
    public constructor(key: string, cert: string);

    public constructor(key?: string, cert?: string)
    {
        // PREPARE SREVER INSTANCE
        if (key)
        {
            this.options_ = ({ key: key, cert: cert });
            this.server_ = https.createServer(this.options_);
        }
        else
            this.server_ = http.createServer();

        // INITIALIZE STATUS & PROTOCOL
        this.state_ = WebServer.State.NONE;
        this.protocol_ = new WebSocket.Server({ noServer: true });
    }

    /**
     * Open websocket server.
     * 
     * Open a server through the web-socket protocol, with its *port* number and *handler* 
     * function determining whether to accept the client's connection or not. After the server has 
     * been opened, clients can connect to that websocket server by using the {@link WebConnector} 
     * class.
     * 
     * When implementing the *handler* function with the {@link WebAcceptor} instance, calls the 
     * {@link WebAcceptor.accept} method if you want to accept the new client's connection. 
     * Otherwise you dont't want to accept the client and reject its connection, just calls the 
     * {@link WebAcceptor.reject} instead.
     * 
     * @param port Port number to listen.
     * @param handler Callback function for client connection.
     */
    public async open
        (
            port: number, 
            handler: (acceptor: WebAcceptor<Header, Provider>) => Promise<void>
        ): Promise<void>
    {
        //----
        // PRELIMINARIES
        //----
        // POSSIBLE TO OPEN?
        if (this.state_ === WebServer.State.OPEN)
            throw new DomainError("Error on WebServer.open(): it has already been opened.");
        else if (this.state_ === WebServer.State.OPENING)
            throw new DomainError("Error on WebServer.open(): it's on opening, wait for a second.");
        else if (this.state_ === WebServer.State.CLOSING)
            throw new RuntimeError("Error on WebServer.open(): it's on closing.");
        
        // RE-OPEN ?
        else if (this.state_ === WebServer.State.CLOSED)
            this.server_ = this.server_ instanceof http.Server
                ? http.createServer()
                : https.createServer(this.options_!);

        // SET STATE
        this.state_ = WebServer.State.OPENING;

        //----
        // OPEN SERVER
        //----
        // PROTOCOL - ADAPTOR & ACCEPTOR
        this.server_.on("upgrade", (request: __http.IncomingMessage, netSocket: __net.Socket, header: Buffer) =>
        {
            this.protocol_.handleUpgrade(request, netSocket, header, webSocket =>
            {
                webSocket.once("message", async (data: __WebSocket.Data) =>
                {
                    // @todo: custom code is required
                    if (typeof data !== "string")
                        webSocket.close();

                    try
                    {
                        const wrapper: IHeaderWrapper<Header> = JSON.parse(data as string);
                        const acceptor: WebAcceptor<Header, Provider> =  WebAcceptor.create(request, webSocket, wrapper.header);
                        
                        await handler(acceptor);
                    }
                    catch (exp)
                    {
                        webSocket.close();
                    }
                });
            });
        });

        // FINALIZATION
        await this._Open(port);
    }

    /**
     * Close server.
     * 
     * Close all connections between its remote clients ({@link WebConnector}s). 
     * 
     * It destories all RFCs (remote function calls) between this server and remote clients 
     * (through `Driver<Controller>`) that are not returned (completed) yet. The destruction 
     * causes all incompleted RFCs to throw exceptions.
     */
    public async close(): Promise<void>
    {
        // VALIDATION
        if (this.state_ !== WebServer.State.OPEN)
            throw new DomainError("Error on WebServer.close(): server is not opened.");

        // DO CLOSE
        this.state_ = WebServer.State.CLOSING;
        await this._Close();
        this.state_ = WebServer.State.CLOSED;
    }

    /**
     * @hidden
     */
    private _Open(port: number): Promise<void>
    {
        return new Promise((resolve, reject) =>
        {
            // PREPARE RETURNS
            this.server_.on("listening", () =>
            {
                this.state_ = WebServer.State.OPEN;
                this.server_.on("error", () => {});
                resolve();
            });
            this.server_.on("error", error =>
            {
                this.state_ = WebServer.State.NONE;
                reject(error);
            });

            // DO OPEN - START PROVIDE
            this.server_.listen(port);
        });
    }

    /**
     * @hidden
     */
    private _Close(): Promise<void>
    {
        return new Promise(resolve =>
        {
            this.protocol_.close(() =>
            {
                this.server_.close(() =>
                {
                    resolve();
                });
            });
        });
    }

    /* ----------------------------------------------------------------
        ACCESSORS
    ---------------------------------------------------------------- */
    /**
     * Get server state.
     * 
     * Get current state of the websocket server. 
     * 
     * List of values are such like below:
     * 
     *   - `NONE`: The `{@link WebServer} instance is newly created, but did nothing yet.
     *   - `OPENING`: The {@link WebServer.open} method is on running.
     *   - `OPEN`: The websocket server is online.
     *   - `CLOSING`: The {@link WebServer.close} method is on running.
     *   - `CLOSED`: The websocket server is offline.
     */
    public get state(): WebServer.State
    {
        return this.state_;
    }
}

/**
 * 
 */
export namespace WebServer
{
    /**
     * Current state of the {@link WebServer}.
     */
    export import State = IServer.State;
}