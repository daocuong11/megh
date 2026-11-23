/**
 * @copyright 2024
 * @author Tareq Hossain
 * @email xtrinsic96@gmail.com
 * @url https://github.com/xtareq
 */
import { withStatus } from "./results";
import { shapeAs } from "../validator/serialize";

/** A class to shape response data with (`@Expose`, `@Exclude`, `@Type`, `@Transform`). */
export type ClassConstructor<T> = new (...args: any[]) => T;

/** class-transformer's response options: only exposed properties, converted to their declared types. */
const RESPONSE_OPTIONS = {
  enableImplicitConversion: true,
  excludeExtraneousValues: true,
};

export interface IHttpResponse<T extends any> {
  message: string;
  data: T | null;
}

export class HttpResponse {
  static Ok<T>(obj: any, s?: ClassConstructor<T>): IHttpResponse<T> {
    if (s) {
      const isPaginated = obj?.hasOwnProperty("total");
      const dataToTransform = isPaginated ? obj.data : obj;

      const transformedData = shapeAs(s, dataToTransform, RESPONSE_OPTIONS);

      const transformedResult = isPaginated
        ? { ...obj, data: transformedData }
        : { data: transformedData };

      return {
        message: "success",
        ...transformedResult,
      };
    }

    return { message: "success", data: obj };
  }

  static Created<T>(obj: any, s?: ClassConstructor<T>): IHttpResponse<T> {
    if (s) {
      const transformedData = shapeAs(s, obj, RESPONSE_OPTIONS);

      return withStatus(
        { message: "created", data: transformedData as T },
        201,
      );
    }

    return withStatus({ message: "created", data: obj }, 201);
  }

  /** Responds with 204 and an empty body. */
  static NoContent(): IHttpResponse<null> {
    return withStatus({ message: "no content", data: null }, 204);
  }
}
