import { Workspace } from "@/components/Workspace";
import { BUILD_GIT_HASH, BUILD_TIMESTAMP, BUILD_VERSION } from "@/app/build-info";

export default function Page() {
  return (
    <Workspace
      buildVersion={BUILD_VERSION}
      buildGitHash={BUILD_GIT_HASH}
      buildTimestamp={BUILD_TIMESTAMP}
    />
  );
}