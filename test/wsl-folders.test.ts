import { expect, test } from "bun:test";
import { checkoutsOf, knowFolders, lookAtFoldersElsewhere, resolveRepos } from "../where";

// A file of its own: it puts `where.ts` in the host thread's mode, for the rest of the process.

test("the host's thread places WSL folders by what the scan worker found, and never looks itself", () => {
  lookAtFoldersElsewhere();
  const checkout = "\\\\wsl.localhost\\Distro\\home\\u\\src\\tokstat-app";
  const added = knowFolders(
    [
      ["/home/u/src/tokstat-app.worktrees/feat", "tokstat-app"],
      ["/home/u/src/gone", null],
    ],
    [["tokstat-app", [checkout]]],
  );
  expect(added).toBe(true);
  // Told again: nothing new.
  expect(knowFolders([["/home/u/src/gone", null]], [])).toBe(false);
  const repos = resolveRepos([
    "/home/u/src/tokstat-app.worktrees/feat",
    // Gone: its own name.
    "/home/u/src/gone",
    // Not looked at by the worker yet: placed by its path meanwhile.
    "/home/u/src/tokstat-new.worktrees/x",
  ]);
  expect(Object.fromEntries(repos)).toEqual({
    "/home/u/src/tokstat-app.worktrees/feat": "tokstat-app",
    "/home/u/src/gone": "gone",
    "/home/u/src/tokstat-new.worktrees/x": "tokstat-new",
  });
  // The worker's checkout is read for lines, without asking over 9P whether it is there.
  expect(checkoutsOf("tokstat-app")).toEqual([checkout]);
});
