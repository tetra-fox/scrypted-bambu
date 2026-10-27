export const chamberInputArguments = (url: string): string[] => {
  return ["-f", "mpjpeg", "-i", url];
};

// the feed has no timestamps, so stamp frames with the wall clock in the filter graph.
// ffmpeg 6.1 (what scrypted ships) ignores -use_wallclock_as_timestamps for mjpeg input
export const WALL_CLOCK_FILTER = "setpts=(RTCTIME-RTCSTART)/(TB*1000000)";

// the feed resends the ~1 fps source at the rate the encoder outputs
const FRAME_RATE = 10;
export const FRAME_PACING_MS = 1000 / FRAME_RATE;

// the 2 second gop keeps startup quick. no -tune zerolatency, homekit live view buffers
// forever on that output when it copies the stream instead of transcoding
export const DEFAULT_ENCODER_ARGUMENTS = `-vf ${WALL_CLOCK_FILTER} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${FRAME_RATE} -g ${FRAME_RATE * 2} -bf 0 -b:v 1000k -maxrate 1000k -bufsize 2000k`;

// pacing stops once the printer has been silent this long, so a dead printer stalls
// ffmpeg and the stream ends instead of freezing on the last frame
export const STALE_FRAME_MS = 5000;

export const splitArguments = (value: string): string[] => {
  return value.split(" ").filter((arg) => arg);
};
