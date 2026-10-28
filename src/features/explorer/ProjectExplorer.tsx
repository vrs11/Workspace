import { Files, Search } from "lucide-react";
import { DockHeader } from "../workspace/DockWorkspace";
import Explorer from "./Explorer";
import SearchPanel from "../search/SearchPanel";
export default function ProjectExplorer({
  search,
  onMode,
}: {
  search: boolean;
  onMode: (search: boolean) => void;
}) {
  return (
    <div className="project-explorer">
      <DockHeader>
        <div
          className="explorer-modes"
          role="tablist"
          aria-label="Explorer views"
        >
          <button
            role="tab"
            aria-selected={!search}
            className={!search ? "active" : ""}
            onClick={() => onMode(false)}
          >
            <Files size={14} />
            Files
          </button>
          <button
            role="tab"
            aria-selected={search}
            className={search ? "active" : ""}
            onClick={() => onMode(true)}
          >
            <Search size={14} />
            Search
          </button>
        </div>
      </DockHeader>
      <div className="explorer-mode" hidden={search}>
        <Explorer active={!search} />
      </div>
      <div className="explorer-mode" hidden={!search}>
        <SearchPanel />
      </div>
    </div>
  );
}
