import { expect, test } from "bun:test";
import { folderLabel, homeOf } from "../where";

test("a copied machine's home is the one most of its calls ran under", () => {
  const cwds = ["/home/jimmy/src/odi", "/home/jimmy", "/tmp/x", "/home/bob/y", "/home/jimmy/src/a"];
  expect(homeOf(cwds)).toBe("/home/jimmy");
  expect(homeOf(["/root/work", "/tmp"])).toBe("/root");
  // A host on Windows' own folders are no copied machine's home.
  expect(homeOf(["/tmp", "C:\\Users\\jimmy", ""])).toBeNull();
});

test("a folder is labelled from its machine's home, with either separator", () => {
  expect(folderLabel("/home/jimmy/src/odi", "/home/jimmy")).toBe("~/src/odi");
  expect(folderLabel("/home/jimmy", "/home/jimmy")).toBe("~");
  expect(folderLabel("/home/jimmyx/src", "/home/jimmy")).toBe("/home/jimmyx/src");
  expect(folderLabel("C:\\Users\\jimmy\\src\\prifly", "C:\\Users\\jimmy")).toBe("~\\src\\prifly");
  expect(folderLabel("", "/home/jimmy")).toBe("unknown");
});
