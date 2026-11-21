import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Container,
  ContainerError,
  Inject,
  Injectable,
  Optional,
  Token,
  constructWith,
  createInjectDecorator,
  inject,
} from "./container";
import { SystemUseError } from "../common/exceptions/system-exception";

describe("Container", () => {
  afterEach(() => {
    Container.reset();
  });

  it("constructs an @Injectable class with its constructor dependencies", () => {
    @Injectable()
    class Clock {
      now() {
        return 42;
      }
    }
    @Injectable()
    class Greeter {
      constructor(readonly clock: Clock) {}
    }

    const greeter = Container.get(Greeter);
    expect(greeter.clock.now()).toBe(42);
    expect(Container.get(Greeter)).toBe(greeter);
  });

  it("stores and resolves values by token", () => {
    const DB_URL = new Token<string>("DB_URL");
    expect(Container.has(DB_URL)).toBe(false);

    Container.set(DB_URL, "postgres://localhost");

    expect(Container.has(DB_URL)).toBe(true);
    expect(Container.get(DB_URL)).toBe("postgres://localhost");
  });

  it("lets a set value replace the class a dependent receives", () => {
    @Injectable()
    class Mailer {
      send() {
        return "real";
      }
    }
    @Injectable()
    class Signup {
      constructor(readonly mailer: Mailer) {}
    }

    Container.set(Mailer, { send: () => "fake" });

    expect(Container.get(Signup).mailer.send()).toBe("fake");
  });

  it("rebuilds class instances after reset, keeping token values", () => {
    @Injectable()
    class Counter {}
    const NAME = new Token<string>("NAME");
    const before = Container.get(Counter);
    Container.set(NAME, "megh");

    Container.reset();

    expect(Container.get(Counter)).not.toBe(before);
    expect(Container.get(NAME)).toBe("megh");
  });

  it("discards instances on reset without calling their destroy()", () => {
    class Connection {
      destroyed = false;
      destroy() {
        this.destroyed = true;
      }
    }
    const conn = new Connection();
    Container.set(Connection, conn);

    Container.reset();

    expect(conn.destroyed).toBe(false);
  });
});

describe("Container errors", () => {
  afterEach(() => {
    Container.reset();
  });

  it("explains how to register an unknown class", () => {
    class Unregistered {}

    expect(() => Container.get(Unregistered)).toThrow(ContainerError);
    expect(() => Container.get(Unregistered)).toThrow(
      "Unregistered is not registered. Mark it with @Injectable() (or @AppService), or register an instance with MeghContainer.set(Unregistered, value).",
    );
  });

  it("names the token or string that has no value", () => {
    expect(() => Container.get(new Token("MISSING"))).toThrow(
      /Nothing is registered for Token "MISSING"/,
    );
    expect(() => Container.get("missing-name")).toThrow(
      /Nothing is registered for "missing-name"/,
    );
  });

  it("shows which constructor needed the missing dependency", () => {
    class Mailer {}
    @Injectable()
    class Notifier {
      constructor(readonly mailer: Mailer) {}
    }
    @Injectable()
    class Signup {
      constructor(readonly notifier: Notifier) {}
    }

    expect(() => Container.get(Signup)).toThrow(
      "Cannot construct Signup -> Notifier: Mailer is not registered.",
    );
  });

  it("reports a dependency cycle instead of overflowing the stack", () => {
    @Injectable()
    class A {
      constructor() {
        Container.get(B);
      }
    }
    @Injectable()
    class B {
      constructor() {
        Container.get(A);
      }
    }

    expect(() => Container.get(A)).toThrow("Circular dependency: A -> B -> A.");
  });

  it("can construct a class again after a constructor threw", () => {
    let fail = true;
    @Injectable()
    class Flaky {
      constructor() {
        if (fail) throw new Error("boom");
      }
    }

    expect(() => Container.get(Flaky)).toThrow("boom");
    fail = false;
    expect(Container.get(Flaky)).toBeInstanceOf(Flaky);
  });
});

describe("Container resolution", () => {
  afterEach(() => {
    Container.reset();
  });

  describe("parameters it can't resolve (#137)", () => {
    interface PaymentGateway {
      charge(n: number): Promise<void>;
    }

    it("fails on an interface parameter, naming it and the fix", () => {
      @Injectable()
      class OrderService {
        constructor(readonly gateway: PaymentGateway) {}
      }
      expect(() => Container.get(OrderService)).toThrow(ContainerError);
      expect(() => Container.get(OrderService)).toThrow(
        "Cannot resolve parameter 0 of OrderService: its type is an interface, union or primitive (emitted as Object). Use @Inject(TOKEN)",
      );
    });

    it("fails on a union, a string and Object itself", () => {
      @Injectable()
      class Union {
        constructor(readonly v: string | number) {}
      }
      @Injectable()
      class Str {
        constructor(readonly name: string) {}
      }
      @Injectable()
      class Obj {
        constructor(readonly o: object) {}
      }
      expect(() => Container.get(Union)).toThrow(
        /parameter 0 of Union.*Object/,
      );
      expect(() => Container.get(Str)).toThrow(/parameter 0 of Str.*String/);
      expect(() => Container.get(Obj)).toThrow(/parameter 0 of Obj.*Object/);
    });

    it("names the chain when a dependency has the bad parameter", () => {
      @Injectable()
      class Inner {
        constructor(readonly n: number) {}
      }
      @Injectable()
      class Outer {
        constructor(readonly inner: Inner) {}
      }
      expect(() => Container.get(Outer)).toThrow(
        /Cannot construct Outer -> Inner: Cannot resolve parameter 0 of Inner.*Number/,
      );
    });

    it("injects a token with @Inject", () => {
      const PAYMENTS = new Token<PaymentGateway>("payments");
      const gateway: PaymentGateway = { charge: async () => {} };
      Container.set(PAYMENTS, gateway);
      @Injectable()
      class OrderService {
        constructor(@Inject(PAYMENTS) readonly gateway: PaymentGateway) {}
      }
      expect(Container.get(OrderService).gateway).toBe(gateway);
    });

    it("injects undefined with @Optional, or @Inject(..., { optional })", () => {
      class Unregistered {}
      const MISSING = new Token<string>("missing");
      @Injectable()
      class Client {
        constructor(
          @Optional() readonly name: string,
          @Optional() readonly extra: Unregistered,
          @Inject(MISSING, { optional: true }) readonly missing: string,
        ) {}
      }
      const client = Container.get(Client);
      expect(client.name).toBeUndefined();
      expect(client.extra).toBeUndefined();
      expect(client.missing).toBeUndefined();
    });

    it("still resolves a registered class marked @Optional", () => {
      @Injectable()
      class Dep {}
      @Injectable()
      class Client {
        constructor(@Optional() readonly dep: Dep) {}
      }
      expect(Container.get(Client).dep).toBeInstanceOf(Dep);
    });

    it("lets overrides stand in for the parameter", () => {
      @Injectable()
      class OrderService {
        constructor(readonly gateway: PaymentGateway) {}
      }
      const fake = { charge: async () => {} };
      expect(constructWith(OrderService, [fake]).gateway).toBe(fake);
    });
  });

  it("knows a decorated class before it is constructed", () => {
    @Injectable()
    class Lazy {}
    expect(Container.has(Lazy)).toBe(true);
  });

  it("rebuilds a class that was replaced with set() once reset", () => {
    @Injectable()
    class Mailer {
      kind = "real";
    }
    Container.set(Mailer, { kind: "fake" });
    expect(Container.get(Mailer).kind).toBe("fake");

    Container.reset();

    expect(Container.get(Mailer).kind).toBe("real");
  });

  it("does not let @Injectable() discard a value set earlier", () => {
    class Late {}
    const value = new Late();
    Container.set(Late, value);

    Injectable()(Late);

    expect(Container.get(Late)).toBe(value);
  });

  it("injects into a subclass that inherits its parent's constructor", () => {
    @Injectable()
    class Clock {}
    @Injectable()
    class Base {
      constructor(readonly clock: Clock) {}
    }
    @Injectable()
    class Child extends Base {}

    expect(Container.get(Child).clock).toBe(Container.get(Clock));
  });

  it("shares one registry across copies of the module", async () => {
    const DB = new Token<string>("SHARED_DB");
    Container.set(DB, "one");

    vi.resetModules();
    const copy = await import("./container");

    expect(copy.Container).not.toBe(Container);
    expect(copy.Container.get(DB)).toBe("one");
  });
});

describe("inject", () => {
  afterEach(() => {
    Container.reset();
  });

  it("injects into field initializers, with no constructor metadata", () => {
    @Injectable()
    class Clock {
      now() {
        return 42;
      }
    }
    // Registered with a call, not a decorator, so TypeScript emits no
    // design:paramtypes for it: inject() doesn't need any.
    class Report {
      private readonly clock = inject(Clock);
      time() {
        return this.clock.now();
      }
    }
    Injectable()(Report);

    expect(Container.get(Report).time()).toBe(42);
  });

  it("returns the same instance constructor injection gets", () => {
    @Injectable()
    class Db {}
    @Injectable()
    class ByField {
      readonly db = inject(Db);
    }
    @Injectable()
    class ByConstructor {
      constructor(readonly db: Db) {}
    }

    expect(Container.get(ByField).db).toBe(Container.get(ByConstructor).db);
  });

  it("resolves tokens and named values", () => {
    const URL = new Token<string>("URL");
    Container.set(URL, "postgres://db");
    Container.set("region", "eu");

    expect(inject(URL)).toBe("postgres://db");
    expect(inject<string>("region")).toBe("eu");
  });

  it("works outside a class, such as in a startup script", () => {
    @Injectable()
    class Settings {
      port = 4000;
    }
    expect(inject(Settings).port).toBe(4000);
  });

  it("returns undefined for an optional dependency that isn't registered", () => {
    class Analytics {}
    @Injectable()
    class Checkout {
      readonly analytics = inject(Analytics, { optional: true });
    }

    expect(Container.get(Checkout).analytics).toBeUndefined();
  });

  it("still throws when an optional dependency is registered but can't be built", () => {
    class Missing {}
    @Injectable()
    class Analytics {
      constructor(readonly missing: Missing) {}
    }

    expect(() => inject(Analytics, { optional: true })).toThrow(
      "Cannot construct Analytics: Missing is not registered.",
    );
  });

  it("names the class whose field needed a missing dependency", () => {
    class Mailer {}
    @Injectable()
    class Signup {
      readonly mailer = inject(Mailer);
    }

    expect(() => Container.get(Signup)).toThrow(
      "Cannot construct Signup: Mailer is not registered.",
    );
  });

  it("reports a cycle between field initializers", () => {
    @Injectable()
    class Orders {
      readonly users: Users = inject(Users);
    }
    @Injectable()
    class Users {
      readonly orders = inject(Orders);
    }

    expect(() => inject(Orders)).toThrow(
      "Circular dependency: Orders -> Users -> Orders.",
    );
  });

  it("throws a SystemUseError, as the inject() helper it replaces did", () => {
    class Unknown {}
    expect(() => inject(Unknown)).toThrow(SystemUseError);
    expect(() => inject(Unknown)).toThrow(ContainerError);
  });
});

describe("createInjectDecorator", () => {
  afterEach(() => {
    Container.reset();
  });

  it("applies a parent's parameter handler to a subclass without its own constructor", () => {
    const InjectGreeting = () => createInjectDecorator(() => "hi");
    @Injectable()
    class Base {
      constructor(@InjectGreeting() readonly greeting: string) {}
    }
    @Injectable()
    class Child extends Base {}

    expect(Container.get(Child).greeting).toBe("hi");
  });

  it("injects properties declared on a parent class", () => {
    const InjectValue = () => createInjectDecorator(() => 7);
    class Base {
      @InjectValue()
      value!: number;
    }
    @Injectable()
    class Child extends Base {}

    expect(Container.get(Child).value).toBe(7);
  });

  it("injects the factory's value into a constructor parameter and a property", () => {
    const InjectGreeting = () => createInjectDecorator(() => "hello");

    @Injectable()
    class Service {
      @InjectGreeting()
      greeting!: string;

      constructor(@InjectGreeting() readonly fromConstructor: string) {}
    }

    const service = Container.get(Service);
    expect(service.fromConstructor).toBe("hello");
    expect(service.greeting).toBe("hello");
  });
});
