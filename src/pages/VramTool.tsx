import { titleFor } from "../routes.ts";

export function VramTool() {
  return (
    <>
      <title>{titleFor("/tools/vram")}</title>
      <h1>{titleFor("/tools/vram").split(" — ")[0]}</h1>
    </>
  );
}
