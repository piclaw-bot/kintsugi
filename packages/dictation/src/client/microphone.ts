/// <reference lib="dom" />

export type MicrophoneLease = {
  stream: MediaStream;
  release(): void;
};

type RequestMicrophone = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

/** Shares a stream during recording and closes it when the last recording stops. */
export class SharedMicrophone {
  private stream?: MediaStream;
  private pending?: Promise<MediaStream>;
  private leases = 0;

  constructor(private readonly request: RequestMicrophone = (constraints) => navigator.mediaDevices.getUserMedia(constraints)) {}

  async acquire(): Promise<MicrophoneLease> {
    const stream = await this.liveStream();
    this.leases += 1;
    for (const track of stream.getAudioTracks()) track.enabled = true;
    let released = false;
    return {
      stream,
      release: () => {
        if (released) return;
        released = true;
        this.leases -= 1;
        if (this.leases !== 0) return;
        for (const track of stream.getTracks()) track.stop();
        this.stream = undefined;
      },
    };
  }

  private async liveStream(): Promise<MediaStream> {
    if (this.stream?.active) return this.stream;

    this.pending ??= this.request({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    }).then((stream) => {
      this.stream = stream;
      return stream;
    }).finally(() => {
      this.pending = undefined;
    });
    return await this.pending;
  }
}
