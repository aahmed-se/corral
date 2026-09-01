import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Inbox, Library } from 'lucide-react';
import { UNFILED, type FolderCount } from '../lib/db.ts';
import { buildTree, type TreeNode } from '../lib/folder-tree.ts';
import type { DragState } from './use-drag.ts';
import type { ViewSelection } from './use-corral.ts';

export { buildTree, type TreeNode } from '../lib/folder-tree.ts';

function formatCount(count: number) {
  return new Intl.NumberFormat(undefined, { notation: count > 9_999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(count);
}

const EXPANDED_KEY = 'corral-expanded';

export function FolderTree({ folders, total, selection, onSelect, drag, onNewFolder, onFolderContextMenu, onFolderPointerDown }: {
  folders: FolderCount[];
  total: number;
  selection: ViewSelection;
  onSelect: (view: ViewSelection) => void;
  drag: DragState | null;
  onNewFolder: () => void;
  onFolderContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  onFolderPointerDown: (event: ReactPointerEvent, path: string) => void;
}) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const stored = window.localStorage.getItem(EXPANDED_KEY);
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(expanded)));
    } catch {
      // Storage may be unavailable; expansion state is a convenience only.
    }
  }, [expanded]);

  // Registers the spring-loaded expansion hook for the drag controller,
  // which lives outside this component.
  useEffect(() => {
    springExpandTarget = (path: string) => setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)));
    return () => {
      springExpandTarget = null;
    };
  }, []);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const isExpanded = expanded.has(node.path);
    const hasChildren = node.children.length > 0;
    const isActive = selection.view === 'folder' && selection.folder === node.path;
    const isDropTarget = drag !== null && drag.overFolder === node.path;
    return (
      <div key={node.path}>
        <div
          className={`tree-row${isActive ? ' active' : ''}${isDropTarget ? ' drop-target' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          data-drop-folder={node.path}
          data-spring-expand={hasChildren && !isExpanded ? 'true' : undefined}
          role="treeitem"
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-selected={isActive}
          tabIndex={0}
          onClick={() => onSelect({ view: 'folder', folder: node.path })}
          onContextMenu={(event) => {
            event.preventDefault();
            onFolderContextMenu(event, node);
          }}
          onPointerDown={(event) => onFolderPointerDown(event, node.path)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSelect({ view: 'folder', folder: node.path });
            if (event.key === 'ArrowRight' && hasChildren && !isExpanded) toggle(node.path);
            if (event.key === 'ArrowLeft' && isExpanded) toggle(node.path);
          }}
        >
          <button
            className={`tree-chevron${hasChildren ? '' : ' hidden'}${isExpanded ? ' open' : ''}`}
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              toggle(node.path);
            }}
          >
            <ChevronRight />
          </button>
          {node.path === UNFILED ? <Inbox className="tree-icon" /> : isExpanded && hasChildren ? <FolderOpen className="tree-icon" /> : <Folder className="tree-icon" />}
          <span className="tree-name" title={node.path}>{node.name}</span>
          <span className="tree-count">{formatCount(node.total)}</span>
        </div>
        {hasChildren && isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const allActive = selection.view === 'all';
  const allDropTarget = drag !== null && drag.overFolder === '';
  return (
    <>
      <div className="sidebar-hdr">
        <span className="mono-label">Folder tree</span>
        <button className="hdr-btn" title="New folder" aria-label="New folder" onClick={onNewFolder}>
          <FolderPlus />
        </button>
      </div>
      <nav className="folder-tree" aria-label="Folders" role="tree" data-drag-scroll="true">
        <div
          className={`tree-row all-row${allActive ? ' active' : ''}${allDropTarget ? ' drop-target' : ''}`}
          role="treeitem"
          aria-selected={allActive}
          tabIndex={0}
          data-drop-folder=""
          onClick={() => onSelect({ view: 'all', folder: '' })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSelect({ view: 'all', folder: '' });
          }}
        >
          <Library className="tree-icon" />
          <span className="tree-name">All bookmarks</span>
          <span className="tree-count">{formatCount(total)}</span>
        </div>
        {tree.map((node) => renderNode(node, 0))}
      </nav>
    </>
  );
}

/** Bridge for the drag controller's spring expansion (module-level because the
 * controller lives outside the tree component). */
let springExpandTarget: ((folder: string) => void) | null = null;

export function springExpand(folder: string) {
  springExpandTarget?.(folder);
}
