import { describe, expect, jest, test } from "bun:test";
import { SharedMicrophone } from "../../src/client/microphone.ts";

function fakeStream() {
  const trackStub: Partial<MediaStreamTrack> = { enabled: true, stop: jest.fn() };
  // SAFETY: The track stub supplies enabled and stop, the only track operations used here.
  const track = trackStub as MediaStreamTrack;
  // SAFETY: The stub supplies the MediaStream operations used by SharedMicrophone
  // and is never passed to browser APIs.
  const stream = { active: true, getAudioTracks: () => [track], getTracks: () => [track] } as MediaStream;
  return { stream, track };
}

describe("SharedMicrophone", () => {
  test("stops immediately on release and requests a fresh stream on restart", async () => {
    const firstStream = fakeStream();
    const nextStream = fakeStream();
    const request = jest.fn().mockResolvedValueOnce(firstStream.stream).mockResolvedValueOnce(nextStream.stream);
    const microphone = new SharedMicrophone(request);
    const first = await microphone.acquire();
    first.release();
    expect(firstStream.track.stop).toHaveBeenCalledTimes(1);
    const next = await microphone.acquire();
    expect(next.stream).toBe(nextStream.stream);
    expect(request).toHaveBeenCalledTimes(2);
    // Releasing an old lease must not affect the new recording.
    first.release();
    expect(nextStream.track.stop).not.toHaveBeenCalled();
    next.release();
    expect(nextStream.track.stop).toHaveBeenCalledTimes(1);
  });

  test("keeps the shared stream alive until all recordings release it", async () => {
    const { stream, track } = fakeStream();
    const request = jest.fn(async () => stream);
    const microphone = new SharedMicrophone(request);
    const [first, second] = await Promise.all([microphone.acquire(), microphone.acquire()]);
    expect(request).toHaveBeenCalledTimes(1);
    first.release();
    first.release();
    expect(track.enabled).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
    second.release();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  test("can retry after a microphone request fails", async () => {
    const { stream, track } = fakeStream();
    const request = jest.fn().mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(stream);
    const microphone = new SharedMicrophone(request);
    await expect(microphone.acquire()).rejects.toThrow("Permission denied");
    const recording = await microphone.acquire();
    expect(recording.stream).toBe(stream);
    recording.release();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
