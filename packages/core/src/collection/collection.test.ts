import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Container } from "../di";
import { BasicCollection, Collection } from "./collection";

type Todo = {
  id: number;
  body: string;
  completed: boolean;
};

describe("Collection", () => {
  let collection!: BasicCollection<Todo>;
  beforeEach(() => {
    collection = Collection.from<Todo>([
      {
        id: 1,
        body: "test 1",
        completed: false,
      },
      {
        id: 2,
        body: "test 2",
        completed: true,
      },
      {
        id: 3,
        body: "test 2",
        completed: true,
      },
    ]);
  });

  afterEach(() => {
    collection.clear();
  });

  describe("find()", () => {
    it("should be return collection", () => {
      const result = collection.find();
      expect(result).toHaveProperty("length");
      expect(result.length).toBe(3);
    });

    it("should return only completed task", () => {
      const result = collection.find((todo) => todo.completed);
      expect(result).toHaveProperty("length");
      expect(result.length).toBe(2);
      expect(result[0].id).toBe(2);
    });
  });

  describe("findOne()", () => {
    it("should be return todo", () => {
      const result = collection.findOne({ where: { id: 1 } });
      expect(result).toHaveProperty("id");
      expect(result?.id).toBe(1);
    });

    it("should return only completed task", () => {
      const result = collection.findOne({
        where: {
          id: {
            $in: [3],
          },
        },
      });
      expect(result).toHaveProperty("id");
      expect(result?.completed).toBe(true);
    });
  });

  describe("paginate()", () => {
    it("should return the first page by default", () => {
      const result = collection.paginate();
      expect(result.data).toHaveLength(3);
      expect(result.meta).toEqual({
        total: 3,
        page: 1,
        perPage: 10,
        lastPage: 1,
        next: null,
        prev: null,
      });
    });

    it("should slice items by page and perPage", () => {
      const page1 = collection.paginate({ page: 1, perPage: 2 });
      expect(page1.data.map((todo) => todo.id)).toEqual([1, 2]);
      expect(page1.meta).toEqual({
        total: 3,
        page: 1,
        perPage: 2,
        lastPage: 2,
        next: 2,
        prev: null,
      });

      const page2 = collection.paginate({ page: 2, perPage: 2 });
      expect(page2.data.map((todo) => todo.id)).toEqual([3]);
      expect(page2.meta.next).toBeNull();
      expect(page2.meta.prev).toBe(1);
    });

    it("should return an empty page beyond the last page", () => {
      const result = collection.paginate({ page: 3, perPage: 2 });
      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(3);
      expect(result.meta.lastPage).toBe(2);
    });

    it("should clamp page 0 and negative pages to page 1", () => {
      expect(collection.paginate({ page: 0, perPage: 2 }).meta.page).toBe(1);
      expect(
        collection
          .paginate({ page: -2, perPage: 2 })
          .data.map((todo) => todo.id),
      ).toEqual([1, 2]);
    });
  });

  describe("min()", () => {
    it("should return the smallest value of a numeric key", () => {
      expect(collection.min("id")).toBe(1);
    });

    it("should return Infinity for an empty collection", () => {
      collection.clear();
      expect(collection.min("id")).toBe(Infinity);
    });
  });

  describe("findAsync()", () => {
    it("should resolve to all items when no predicate is given", async () => {
      const result = await collection.findAsync();
      expect(result).toHaveLength(3);
    });

    it("should resolve to only matching items", async () => {
      const result = await collection.findAsync((todo) => todo.completed);
      expect(result.map((todo) => todo.id)).toEqual([2, 3]);
    });

    it("should resolve to the same items as find()", async () => {
      const asyncResult = await collection.findAsync((todo) => todo.id > 1);
      const syncResult = collection.find((todo) => todo.id > 1);
      expect(asyncResult).toEqual(syncResult);
    });
  });
});
