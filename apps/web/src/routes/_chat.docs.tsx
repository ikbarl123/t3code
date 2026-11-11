import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "../components/docs/DocsPage";

export const Route = createFileRoute("/_chat/docs")({
  validateSearch: (raw: Record<string, unknown>): { note?: string } => {
    const note =
      typeof raw.note === "string" ? raw.note.trim().replace(/^\/+/, "").slice(0, 500) : "";
    return note ? { note } : {};
  },
  component: DocsRoute,
});

function DocsRoute() {
  const { note } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <DocsPage
      note={note ?? null}
      onNoteChange={(next) => void navigate({ search: next ? { note: next } : {} })}
    />
  );
}
