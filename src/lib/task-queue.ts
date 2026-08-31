// A macrotask yield that lets queued messages and IndexedDB events run
// between work chunks — WITHOUT setTimeout. Browsers clamp background-tab
// timers to a second or more (workers included), which turned chunked
// imports and rebuilds into a crawl whenever the tab was hidden.
// MessageChannel messages are not throttled.

let channel: MessageChannel | null = null;
const resolvers: Array<() => void> = [];

export function yieldToQueue(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => resolvers.shift()?.();
  }
  return new Promise((resolve) => {
    resolvers.push(resolve);
    channel!.port2.postMessage(null);
  });
}
