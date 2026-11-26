import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ApiController } from "../src/common/decorators";
import {
  CONTROLLER_META_KEY,
  getRegisteredControllers,
  isApiController,
} from "../src/common/container";
import { Container } from "../src/di";

@ApiController({
  path: "/home",
})
class HomeController {}

@ApiController({
  name: "Products",
})
class ProductController {}

describe("All decorator test", () => {
  describe("Contorller decorator test", () => {
    it("it should be have name as prefix", () => {
      expect(getRegisteredControllers()).toEqual(
        expect.arrayContaining([HomeController, ProductController]),
      );
      expect(isApiController(HomeController)).toBe(true);
      expect(isApiController(ProductController)).toBe(true);
    });

    it("should have options ", () => {
      const instance = Container.get(HomeController);
      expect(instance).toBeDefined();
      expect(Reflect.getMetadata(CONTROLLER_META_KEY, HomeController)).toEqual({
        type: "api",
        path: "/home",
        options: { path: "/home" },
      });
      expect(Reflect.getMetadata(CONTROLLER_META_KEY, ProductController)).toEqual({
        type: "api",
        path: "/",
        options: { name: "Products" },
      });
    });
  });
});
