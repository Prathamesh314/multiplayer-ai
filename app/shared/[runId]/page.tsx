import { SharedChatPage } from "../../components/sharing/SharedChatPage";
export const metadata = {title:"Shared chat",robots:{index:false,follow:false}};
export default async function Page({params}:PageProps<"/shared/[runId]">) {
  const {runId}=await params;
  return <SharedChatPage key={runId} runId={runId}/>;
}
