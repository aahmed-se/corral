import { FOLDER_SEPARATOR, type FolderCount } from './view-index.ts';

const UNFILED = 'Unsorted';

export type TreeNode = {
  name: string;
  path: string;
  own: number;
  total: number;
  children: TreeNode[];
};

/** Builds the folder tree from flat `A / B / C` paths. Missing intermediate
 * folders are synthesized and subtree totals roll up from every descendant. */
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

  for (const { folder, count } of folders) ensure(folder).own = count;

  const rollUp = (node: TreeNode): number => {
    node.total = node.own + node.children.reduce((sum, child) => sum + rollUp(child), 0);
    return node.total;
  };
  rollUp(root);

  const sortChildren = (node: TreeNode) => {
    node.children.sort((left, right) => {
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

export function findTreeNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findTreeNode(node.children, path);
    if (found) return found;
  }
  return undefined;
}
