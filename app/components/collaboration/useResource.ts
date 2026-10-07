"use client";
import { useCallback, useEffect, useState } from "react";
import { sharingRequest, SharingRequestError } from "../../lib/sharing/client";

/** Visible-page polling with one in-flight request and abortable deadlines. */
export function useResource<T>(url: string | null, interval = 10_000) {
  const [data,setData] = useState<T|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [version,setVersion] = useState(0);
  const refresh = useCallback(()=>setVersion(v=>v+1),[]);
  useEffect(()=>{
    if(!url) return;
    let disposed=false,working=false;
    let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    async function load() {
      if(disposed||document.hidden||working)return;
      working=true;controller=new AbortController();
      try {
        const value=await sharingRequest<T>(url!,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
        if(!disposed){setData(value);setError(null);}
      } catch(cause) {
        if(!disposed&&!controller.signal.aborted){
          setError(cause instanceof Error?cause.message:"Could not load this view.");
          if(cause instanceof SharingRequestError&&[401,403,404].includes(cause.status))setData(null);
        }
      } finally {working=false;if(!disposed&&interval&&!document.hidden)timer=setTimeout(()=>void load(),interval);}
    }
    const visibility=()=>{clearTimeout(timer);if(document.hidden)controller?.abort();else void load();};
    void load();document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility);};
  },[url,interval,version]);
  return {data,error,refresh};
}
