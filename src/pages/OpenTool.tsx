import { titleFor } from "../routes.ts";

export function OpenTool() {
  return (
    <>
      <title>{titleFor("/tools/open")}</title>
      <h1>{titleFor("/tools/open").split(" — ")[0]}</h1>
    </>
  );
}
