/** Detach on completion: composing every request with one long-lived signal
 * retains huge dependency sets in Node's AbortSignal.any finalizer. */
const subscriptions=new WeakMap();
export function subscribeCancellation(parent,cancel) {
  if(parent.aborted){cancel();return ()=>{};}
  let group=subscriptions.get(parent);
  if(!group){
    const callbacks=new Set();
    const abort=()=>{for(const callback of [...callbacks])callback();};
    group={callbacks,abort};subscriptions.set(parent,group);
    parent.addEventListener('abort',abort,{once:true});
  }
  group.callbacks.add(cancel);
  return ()=>{
    group.callbacks.delete(cancel);
    if(!group.callbacks.size && subscriptions.get(parent)===group){
      parent.removeEventListener('abort',group.abort);subscriptions.delete(parent);
    }
  };
}

export function cancellableDelay(ms,parent) {
  return new Promise((resolve,reject)=>{
    let detach=()=>{};
    const timer=setTimeout(()=>{detach();resolve();},ms);
    detach=subscribeCancellation(parent,()=>{clearTimeout(timer);detach();reject(parent.reason);});
  });
}

export function requestCancellation(parent,timeoutMs) {
  const controller=new AbortController();let timedOut=false;
  const cancel=()=>controller.abort(parent.reason);
  const detach=subscribeCancellation(parent,cancel);
  const timer=setTimeout(()=>{timedOut=true;controller.abort(new DOMException('Request timed out','TimeoutError'));},timeoutMs);
  return {signal:controller.signal,timedOut:()=>timedOut,dispose:()=>{clearTimeout(timer);detach();}};
}
