// Lab-only UI (experiment mode, the Tasks menu, progress details) shows only
// with ?lab in the URL, so the everyday app stays one gesture: point and talk.
export const LAB = new URLSearchParams(location.search).has('lab');
