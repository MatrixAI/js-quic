
  // /**
  //  * Recv plug, await this to know when we can read the data.
  //  */
  // protected recvPlug: Promise<void> = Promise.resolve();
  // protected resolveRecvPlug: (() => void) | null = null;
  //
  // /**
  //  * Plugs the recv.
  //  * This is idempotent.
  //  */
  // protected pauseRecv() {
  //   if (this.resolveRecvPlug == null) {
  //     this.recvPlug = new Promise<void>((resolve) => {
  //       this.resolveRecvPlug = resolve;
  //     });
  //   }
  // }
  //
  // /**
  //  * Unplugs the recv.
  //  * This is idempotent.
  //  */
  // protected resumeRecv() {
  //   if (this.resolveRecvPlug != null) {
  //     this.resolveRecvPlug();
  //     this.resolveRecvPlug = null;
  //   }
  // }
