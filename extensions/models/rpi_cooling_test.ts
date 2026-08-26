// Run with `deno test -A`. -A is needed because catFile/listDirNames shell
// out to `cat`/`find` for /proc and /sys reads — see rpi_health_test.ts /
// host_health_test.ts for why Deno's permission checker requires it even
// for world-readable files.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  assertRaspberryPiHardware,
  findCoolingDeviceByType,
  findHwmonDeviceByName,
  model,
  parseSysfsInt,
  pwmDutyToPercent,
} from "./rpi_cooling.ts";

// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = {
  hwmonBasePath: "/sys/class/hwmon",
  thermalBasePath: "/sys/class/thermal",
  fanHwmonName: "pwmfan",
  fanCoolingDeviceType: "pwm-fan",
};

// --- parseSysfsInt -----------------------------------------------------

Deno.test("parseSysfsInt parses a typical sysfs integer reading", () => {
  assertEquals(parseSysfsInt("2015\n", "fan1_input"), 2015);
  assertEquals(parseSysfsInt("0", "fan1_input"), 0);
});

Deno.test("parseSysfsInt throws on non-integer garbage rather than defaulting to 0", () => {
  assertThrows(
    () => parseSysfsInt("not-a-number", "fan1_input"),
    Error,
    'Could not parse fan1_input as an integer: "not-a-number"',
  );
});

Deno.test("parseSysfsInt throws on a non-integer float", () => {
  assertThrows(
    () => parseSysfsInt("1.5", "pwm1"),
    Error,
    "Could not parse pwm1",
  );
});

// --- pwmDutyToPercent ----------------------------------------------------

Deno.test("pwmDutyToPercent: 0 is 0%, 255 is 100%", () => {
  assertEquals(pwmDutyToPercent(0), 0);
  assertEquals(pwmDutyToPercent(255), 100);
});

Deno.test("pwmDutyToPercent: 75 is ~29.4%", () => {
  assertEquals(pwmDutyToPercent(75), 29.4);
});

// --- findHwmonDeviceByName / findCoolingDeviceByType (mocked) ------------

Deno.test("findHwmonDeviceByName returns null when no device matches", async () => {
  const { result } = await withMockedCommand((command, args) => {
    if (command === "find") return { stdout: "hwmon0\nhwmon1\n", code: 0 };
    if (command === "cat" && args.includes("/sys/class/hwmon/hwmon0/name")) {
      return { stdout: "cpu_thermal\n", code: 0 };
    }
    if (command === "cat" && args.includes("/sys/class/hwmon/hwmon1/name")) {
      return { stdout: "rp1_adc\n", code: 0 };
    }
    return { stdout: "", code: 1 };
  }, () => findHwmonDeviceByName("/sys/class/hwmon", "pwmfan"));
  assertEquals(result, null);
});

Deno.test("findHwmonDeviceByName finds the device whose name file matches, ignoring hwmon index order", async () => {
  const { result } = await withMockedCommand((command, args) => {
    if (command === "find") {
      return { stdout: "hwmon0\nhwmon2\nhwmon1\n", code: 0 };
    }
    if (args.includes("/sys/class/hwmon/hwmon0/name")) {
      return { stdout: "cpu_thermal\n", code: 0 };
    }
    if (args.includes("/sys/class/hwmon/hwmon2/name")) {
      return { stdout: "pwmfan\n", code: 0 };
    }
    if (args.includes("/sys/class/hwmon/hwmon1/name")) {
      return { stdout: "rp1_adc\n", code: 0 };
    }
    return { stdout: "", code: 1 };
  }, () => findHwmonDeviceByName("/sys/class/hwmon", "pwmfan"));
  assertEquals(result, "/sys/class/hwmon/hwmon2");
});

Deno.test("findHwmonDeviceByName skips a device whose name file can't be read rather than failing the whole search", async () => {
  const { result } = await withMockedCommand((command, args) => {
    if (command === "find") return { stdout: "hwmon0\nhwmon1\n", code: 0 };
    if (args.includes("/sys/class/hwmon/hwmon0/name")) {
      return { stdout: "", code: 1 };
    }
    if (args.includes("/sys/class/hwmon/hwmon1/name")) {
      return { stdout: "pwmfan\n", code: 0 };
    }
    return { stdout: "", code: 1 };
  }, () => findHwmonDeviceByName("/sys/class/hwmon", "pwmfan"));
  assertEquals(result, "/sys/class/hwmon/hwmon1");
});

Deno.test("findCoolingDeviceByType ignores non-cooling_device entries and matches by type", async () => {
  const { result } = await withMockedCommand((command, args) => {
    if (command === "find") {
      return { stdout: "cooling_device0\nthermal_zone0\n", code: 0 };
    }
    if (args.includes("/sys/class/thermal/cooling_device0/type")) {
      return { stdout: "pwm-fan\n", code: 0 };
    }
    return { stdout: "", code: 1 };
  }, () => findCoolingDeviceByType("/sys/class/thermal", "pwm-fan"));
  assertEquals(result, "/sys/class/thermal/cooling_device0");
});

// --- readCooling: real hardware + mocked failure/degradation paths -------
//
// This model refuses to run at all off Pi hardware, so — like
// @aaronge/rpi-health's and @aaronge/host-health's method-level tests —
// the primary test exercises the real sysfs on whatever host runs the
// suite, and asserts invariants rather than exact values.

Deno.test("readCooling writes a cooling resource from real sysfs with sane invariants", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCooling",
  });

  await model.methods.readCooling.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "cooling");
  const data = written[0].data as {
    rpm: number;
    pwmDuty: number;
    pwmPercent: number;
    stalled: boolean;
    coolingState: number | null;
    maxCoolingState: number | null;
    deviceName: string;
  };
  assert(data.rpm >= 0);
  assert(data.pwmDuty >= 0 && data.pwmDuty <= 255);
  assert(data.pwmPercent >= 0 && data.pwmPercent <= 100);
  assertEquals(data.stalled, data.rpm === 0 && data.pwmDuty > 0);
  assertEquals(data.deviceName, "pwmfan");
  if (data.coolingState !== null) {
    assert(data.maxCoolingState !== null);
    assert(data.coolingState <= data.maxCoolingState!);
  }
});

Deno.test("readCooling sets stalled=true when rpm=0 and pwmDuty>0 on mocked sysfs", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCooling",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/class/hwmon") {
      return { stdout: "hwmon2\n", code: 0 };
    }
    if (command === "cat" && args.includes("/sys/class/hwmon/hwmon2/name")) {
      return { stdout: "pwmfan\n", code: 0 };
    }
    if (
      command === "cat" && args.includes("/sys/class/hwmon/hwmon2/fan1_input")
    ) {
      return { stdout: "0\n", code: 0 };
    }
    if (command === "cat" && args.includes("/sys/class/hwmon/hwmon2/pwm1")) {
      return { stdout: "75\n", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/class/thermal") {
      return { stdout: "cooling_device0\n", code: 0 };
    }
    if (args.includes("/sys/class/thermal/cooling_device0/type")) {
      return { stdout: "pwm-fan\n", code: 0 };
    }
    if (args.includes("/sys/class/thermal/cooling_device0/cur_state")) {
      return { stdout: "1\n", code: 0 };
    }
    if (args.includes("/sys/class/thermal/cooling_device0/max_state")) {
      return { stdout: "4\n", code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readCooling.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    stalled: boolean;
    rpm: number;
    pwmDuty: number;
  };
  assertEquals(data.stalled, true);
  assertEquals(data.rpm, 0);
  assertEquals(data.pwmDuty, 75);
});

Deno.test("readCooling degrades coolingState/maxCoolingState to null when no matching cooling_device exists, without failing the method", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCooling",
  });

  await withMockedCommand((command, args) => {
    if (command === "cat" && args[0] === "/proc/device-tree/model") {
      return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/class/hwmon") {
      return { stdout: "hwmon2\n", code: 0 };
    }
    if (command === "cat" && args.includes("/sys/class/hwmon/hwmon2/name")) {
      return { stdout: "pwmfan\n", code: 0 };
    }
    if (
      command === "cat" && args.includes("/sys/class/hwmon/hwmon2/fan1_input")
    ) {
      return { stdout: "2015\n", code: 0 };
    }
    if (command === "cat" && args.includes("/sys/class/hwmon/hwmon2/pwm1")) {
      return { stdout: "75\n", code: 0 };
    }
    if (command === "find" && args[0] === "/sys/class/thermal") {
      return { stdout: "\n", code: 0 };
    }
    throw new Error(`unexpected command in test: ${command} ${args.join(" ")}`);
  }, () => model.methods.readCooling.execute({}, asContext(context)));

  const data = getWrittenResources()[0].data as {
    coolingState: number | null;
    maxCoolingState: number | null;
    rpm: number;
  };
  assertEquals(data.coolingState, null);
  assertEquals(data.maxCoolingState, null);
  assertEquals(data.rpm, 2015);
});

Deno.test("readCooling throws a clean error when no hwmon device matches fanHwmonName", async () => {
  const { context } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "readCooling",
  });

  await assertRejects(
    () =>
      withMockedCommand((command, args) => {
        if (command === "cat" && args[0] === "/proc/device-tree/model") {
          return { stdout: "Raspberry Pi 5 Model B Rev 1.1\0", code: 0 };
        }
        if (command === "find" && args[0] === "/sys/class/hwmon") {
          return { stdout: "hwmon0\n", code: 0 };
        }
        if (
          command === "cat" && args.includes("/sys/class/hwmon/hwmon0/name")
        ) {
          return { stdout: "cpu_thermal\n", code: 0 };
        }
        throw new Error(
          `unexpected command in test: ${command} ${args.join(" ")}`,
        );
      }, () => model.methods.readCooling.execute({}, asContext(context))).then((
        r,
      ) => r.result),
    Error,
    'No hwmon device named "pwmfan" found',
  );
});

Deno.test("assertRaspberryPiHardware strips the trailing NUL from /proc/device-tree/model on this real Pi 5", async () => {
  const hardware = await assertRaspberryPiHardware();
  assert(!hardware.model.includes("\0"));
  assertEquals(hardware.model, hardware.model.trim());
  assert(hardware.model.includes("Raspberry Pi"));
});
