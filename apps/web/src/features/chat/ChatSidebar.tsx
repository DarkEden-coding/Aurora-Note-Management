// Chat sidebar: projects as folders, conversations, create/rename/delete.
import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";
import type { ChatConversation } from "@aurora/shared";
import { useLibrary } from "../library/LibraryContext.js";
import * as chatApi from "./api.js";

export function ChatSidebar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (conversation: ChatConversation | null) => void;
}) {
  const library = useLibrary();
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refresh = () => {
    void chatApi
      .listConversations()
      .then((result) => setConversations(result.conversations))
      .catch(() => undefined);
  };

  useEffect(() => {
    refresh();
  }, []);

  const create = async (projectId: string) => {
    const conversation = await chatApi.createConversation(projectId);
    setConversations((current) => [conversation, ...current]);
    setExpanded((current) => new Set(current).add(projectId));
    onSelect(conversation);
  };

  const remove = async (id: string) => {
    await chatApi.deleteConversation(id);
    setConversations((current) => current.filter((item) => item.id !== id));
    if (selectedId === id) onSelect(null);
  };

  const commitRename = async () => {
    if (!renameId) return;
    const title = renameValue.trim();
    setRenameId(null);
    if (!title) return;
    const updated = await chatApi.renameConversation(renameId, title);
    setConversations((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    if (selectedId === updated.id) onSelect(updated);
  };

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">Projects</div>
      {library.projects.map((project) => {
        const open = expanded.has(project.id);
        const items = conversations.filter(
          (item) => item.projectId === project.id,
        );
        return (
          <div key={project.id}>
            <div className="tree-item project-row">
              <button
                type="button"
                className="tree-row tree-row-main"
                onClick={() => {
                  const next = new Set(expanded);
                  next.has(project.id)
                    ? next.delete(project.id)
                    : next.add(project.id);
                  setExpanded(next);
                }}
              >
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <FolderOpen size={16} className="muted" />
                <span className="label">
                  <strong>{project.name}</strong>
                </span>
              </button>
              <button
                type="button"
                className="tree-action"
                aria-label={`New chat in ${project.name}`}
                onClick={() => void create(project.id)}
              >
                <Plus size={15} />
              </button>
            </div>
            {open ? (
              <div className="tree-children">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`tree-item${selectedId === item.id ? " selected" : ""}`}
                  >
                    {renameId === item.id ? (
                      <input
                        className="tree-row tree-row-main"
                        value={renameValue}
                        autoFocus
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void commitRename();
                          if (event.key === "Escape") setRenameId(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="tree-row tree-row-main"
                        onClick={() => onSelect(item)}
                        onDoubleClick={() => {
                          setRenameId(item.id);
                          setRenameValue(item.title);
                        }}
                      >
                        <MessageSquare size={15} className="muted" />
                        <span className="label">{item.title}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="tree-action danger"
                      aria-label={`Delete ${item.title}`}
                      onClick={() => void remove(item.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {library.projects.length === 0 ? (
        <div className="tree-row muted">Create a project in Notes first.</div>
      ) : null}
    </div>
  );
}
