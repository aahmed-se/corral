import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Inbox, Library } from 'lucide-react';
import { FOLDER_SEPARATOR, UNFILED, type FolderCount } from '../lib/db.ts';
import type { DragState } from './use-drag.ts';
import type { ViewSelection } from './use-corral.ts';

export type TreeNode = {
  name: string;
  path: string;
  own: number;
  total: number;
  children: TreeNode[];
};

/** Builds the folder tree from flat `A / B / C` paths. Subtree totals roll up
 * from every descendant. */
export function buildTree(folders: FolderCount[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', own: 0, total: 0, children: [] };
  const nodes = new Map<string, TreeNode>([['', root]]);

  const ensure = (path: string): TreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf(FOLDER_SEPARATOR);
    const parent = ensure(cut === -1 ? '' : path.slice(0, cut));
    const node: TreeNode = { name: cut === -1 ? path : path.slice(cut + FOLDER_SEPARATOR.length), path, own: 0, total: 0, children: [] };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };

  for (const { folder, count } of folders) {
    ensure(folder).own = count;
  }

  const rollUp = (node: TreeNode): number => {
    node.total = node.own + node.children.reduce((sum, child) => sum + rollUp(child), 0);
    return node.total;
  };
  rollUp(root);

  const sortChildren = (node: TreeNode) => {
    node.children.sort((left, right) => {
      // Unsorted pins to the bottom of the top level; everything else A–Z.
      if (node === root) {
        if (left.path === UNFILED) return 1;
        if (right.path === UNFILED) return -1;
      }
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root.children;
}

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
        <span className="tree-chevron hidden" />
        <Library className="tree-icon" />
        <span className="tree-name">All bookmarks</span>
        <span className="tree-count">{formatCount(total)}</span>
      </div>
      <div className="tree-head">
        <span>Folders</span>
        <button className="icon-button small" title="New folder" aria-label="New folder" onClick={onNewFolder}>
          <FolderPlus />
        </button>
      </div>
      {tree.map((node) => renderNode(node, 0))}
    </nav>
  );
}

/** Bridge for the drag controller's spring expansion (module-level because the
 * controller lives outside the tree component). */
let springExpandTarget: ((folder: string) => void) | null = null;

export function springExpand(folder: string) {
  springExpandTarget?.(folder);
}
