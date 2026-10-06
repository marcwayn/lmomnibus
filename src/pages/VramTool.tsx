import { titleFor } from "../routes.ts";

export function VramTool() {
  const path = "VramTool" === "OpenTool" ? "/tools/open" : "/tools/vram";
  return (
    <>
      <title>{titleFor(path)}</title>
      <h1>{titleFor(path).split(" — ")[0]}</h1>
    </>
  );
}
