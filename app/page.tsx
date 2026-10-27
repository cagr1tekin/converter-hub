import { getManifests } from "@/core/registry";
import Workbench from "./workbench";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <Workbench modules={await getManifests()} />;
}
