import tls from 'tls';
import RemoteMessageManager from './RemoteMessageManager';
import EventEmitter from 'events';
import type Homey from 'homey/lib/Homey';
import apps from './apps';

class RemoteManager extends EventEmitter {
    private host: string;
    private port: number;
    private certs: { key: string | undefined; cert: string | undefined };
    private client: tls.TLSSocket | undefined;
    private chunks: Buffer;
    private error: NodeJS.ErrnoException | null;
    private timeout: number;
    private remoteMessageManager: RemoteMessageManager;
    private reconnectTimeout: number | NodeJS.Timeout | null = null;
    private destroyed: boolean = false;
    private homey: Homey;

    constructor(host: string, port: number, certs: {
        key: string | undefined;
        cert: string | undefined
    }, homey: Homey, timeout: number = 1000, manufacturer: string = 'unknown', model: string = 'unknown', debug: boolean = false) {
        super();
        this.host = host;
        this.port = port;
        this.certs = certs;
        this.chunks = Buffer.from([]);
        this.error = null;
        this.timeout = timeout;
        this.remoteMessageManager = new RemoteMessageManager(manufacturer, model, debug);
        this.homey = homey;
    }

    async start(): Promise<void> {
        return new Promise<void>((resolve) => {
            const options: tls.ConnectionOptions = {
                key: this.certs.key,
                cert: this.certs.cert,
                port: this.port,
                host: this.host,
                rejectUnauthorized: false,
            };

            this.emit('log.debug', 'Start Remote Connect');

            this.client = tls.connect(options, () => {
                //this.emit('log.debug', "Remote connected")
            });

            this.client.on('timeout', () => {
                this.emit('log.debug', 'timeout');
                this.client?.destroy();
            });

            // Ping is received every 5 seconds
            this.client.setTimeout(1000 * 10);

            this.client.on('secureConnect', () => {
                this.emit('log.debug', this.host + ' Remote secureConnect');
                resolve();
            });

            this.client.on('data', (data) => {
                if (this.destroyed) {
                    return;
                }
                try {
                    const buffer = Buffer.from(data);
                    this.chunks = Buffer.concat([this.chunks, buffer]);

                    if (this.chunks.length > 0 && this.chunks.readInt8(0) === this.chunks.length - 1) {
                        const message = this.remoteMessageManager.parse(this.chunks);

                        if (!message.remotePingRequest) {
                            //this.emit('log.debug', this.host + " Receive : " + Array.from(this.chunks));
                            this.emit('log.debug', this.host + ' Receive : ' + JSON.stringify(message));
                        }

                        if (message.remoteConfigure) {
                            this.client?.write(this.remoteMessageManager.createRemoteConfigure());
                            this.emit('ready');
                        } else if (message.remoteSetActive) {
                            this.client?.write(this.remoteMessageManager.createRemoteSetActive(622));
                        } else if (message.remotePingRequest) {
                            this.client?.write(this.remoteMessageManager.createRemotePingResponse(message.remotePingRequest.val1));
                        } else if (message.remoteImeKeyInject) {
                          const appId = message.remoteImeKeyInject.appInfo.appPackage;
                          this.emit('current_app', apps[appId] ?? appId);
                        } else if (message.remoteImeBatchEdit) {
                            this.emit('log.debug', 'Receive IME BATCH EDIT' + message.remoteImeBatchEdit);
                        } else if (message.remoteImeShowRequest) {
                            this.emit('log.debug', 'Receive IME SHOW REQUEST' + message.remoteImeShowRequest);
                        } else if (message.remoteVoiceBegin) {
                            //this.emit('log.debug', "Receive VOICE BEGIN" + message.remoteVoiceBegin);
                        } else if (message.remoteVoicePayload) {
                            //this.emit('log.debug', "Receive VOICE PAYLOAD" + message.remoteVoicePayload);
                        } else if (message.remoteVoiceEnd) {
                            //this.emit('log.debug', "Receive VOICE END" + message.remoteVoiceEnd);
                        } else if (message.remoteStart) {
                            this.emit('powered', message.remoteStart.started);
                        } else if (message.remoteSetVolumeLevel) {
                            this.emit('volume', {
                                level: message.remoteSetVolumeLevel.volumeLevel,
                                maximum: message.remoteSetVolumeLevel.volumeMax,
                                muted: message.remoteSetVolumeLevel.volumeMuted,
                            });
                            //this.emit('log.debug', "Receive SET VOLUME LEVEL" + message.remoteSetVolumeLevel.toJSON().toString());
                        } else if (message.remoteSetPreferredAudioDevice) {
                            //this.emit('log.debug', "Receive SET PREFERRED AUDIO DEVICE" + message.remoteSetPreferredAudioDevice);
                        } else if (message.remoteError) {
                            if (message.remoteError?.message?.remoteConfigure) {
                                this.emit('unpaired', message.remoteError);
                            } else {
                                this.emit('log.debug', "Receive REMOTE ERROR");
                                this.emit('error', message.remoteError);
                            }
                        } else if (message.remoteKeyInject) {
                            this.emit('key', message.remoteKeyInject);
                        } else {
                            this.emit('log.log', 'What else ?');
                        }
                        this.chunks = Buffer.from([]);
                    }
                } catch (error) {
                    this.emit('log.error', 'RemoteManager on data error', error);
                }
            });

            this.client.on('close', async (hasError) => {
                if (this.destroyed) {
                    return;
                }
                this.emit('close', {hasError: hasError, error: this.error});
                this.emit(hasError ? 'log.error' : 'log.info', this.host + ' Remote Connection closed' + (hasError ? ' with error' + JSON.stringify(this.error) : ''));
                const emitError = (error: unknown): boolean => this.emit('log.error', error);

                // We restart. If it has turned off, an error will prevent further restarts.
                if (this.reconnectTimeout) {
                    this.homey.clearTimeout(this.reconnectTimeout);
                }
                this.reconnectTimeout = this.homey.setTimeout(() => this.start().catch(emitError), this.timeout);
            });

            this.client.on('error', (error) => {
                if (this.destroyed) {
                  return;
                }
                this.emit('log.error', this.host, error);
                this.error = error;
            });
        });
    }

    sendPower(): void {
        this.client?.write(
            this.remoteMessageManager.createRemoteKeyInject(
                this.remoteMessageManager.RemoteDirection.SHORT,
                this.remoteMessageManager.RemoteKeyCode.KEYCODE_POWER
            )
        );
    }

    sendKey(key: number, direction: number): void {
        this.client?.write(this.remoteMessageManager.createRemoteKeyInject(direction, key));
    }

    sendAppLink(app_link: string): void {
        this.client?.write(this.remoteMessageManager.createRemoteRemoteAppLinkLaunchRequest(app_link));
    }

    sendVolume(volume: number): void {
        this.client?.write(this.remoteMessageManager.createRemoteAdjustVolumeLevel(volume));
    }

    stop(): void {
        if (this.reconnectTimeout) {
            this.homey.clearTimeout(this.reconnectTimeout);
        }
        this.client?.destroy();
        this.destroyed = true;
    }
}

export {RemoteManager};
