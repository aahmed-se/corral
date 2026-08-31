/// <reference types="vite/client" />

declare module '*?worker' {
  const WorkerConstructor: new (options?: WorkerOptions) => Worker;
  export default WorkerConstructor;
}
