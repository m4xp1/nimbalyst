/** One lane for file scans, rule reconciliation and watcher batches. Read RPCs never join it. */
export class FileWork {
  private tail:Promise<void>=Promise.resolve();
  run<T>(work:()=>Promise<T>):Promise<T>{
    const task=this.tail.then(work);
    this.tail=task.then(()=>{},()=>{});
    return task;
  }
  idle():Promise<void>{return this.tail;}
}
