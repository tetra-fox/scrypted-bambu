export const chamberInputArguments = (url: string): string[] => {
  return ["-f", "mpjpeg", "-i", url];
};

// the feed has no timestamps, so stamp frames with the wall clock in the filter graph.
// ffmpeg 6.1 (what scrypted ships) ignores -use_wallclock_as_timestamps for mjpeg input
export const WALL_CLOCK_FILTER = "setpts=(RTCTIME-RTCSTART)/(TB*1000000)";

// 10 fps repeats the ~1 fps source for players, the 2 second gop keeps startup quick
export const DEFAULT_ENCODER_ARGUMENTS = `-vf ${WALL_CLOCK_FILTER} -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -r 10 -g 20 -bf 0 -b:v 1000k -maxrate 1000k -bufsize 2000k`;

export const splitArguments = (value: string): string[] => {
  return value.split(" ").filter((arg) => arg);
};
