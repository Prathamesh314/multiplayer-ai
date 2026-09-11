import { SessionRoom } from "../../components/workspace/SessionRoom";

export default async function SessionPage(props: PageProps<"/s/[id]">) {
  const { id } = await props.params;
  return <SessionRoom key={id} sessionId={id} />;
}
