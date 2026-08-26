/**
 * Raspberry Pi official-case PWM fan telemetry: tachometer RPM, PWM duty
 * cycle, and discrete thermal cooling state, all from sysfs. Zero-privilege
 * — every source is world-readable. Read-only: this model never writes
 * `pwm1` or otherwise changes the fan's speed. The value proposition is
 * catching a fan that spins but no longer cools, or a fan that's stopped
 * spinning while the firmware still asks it to run — neither failure mode
 * produces any other visible symptom until the SoC starts thermal
 * throttling.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. Deno's
 * permission checker demands the literal `--allow-all` flag for `/proc`
 * reads and symlinked `/sys` attribute file reads — no scoped
 * `--allow-read` satisfies it, even though the files are world-readable
 * either way. Same workaround `@aaronge/host-health` and
 * `@aaronge/rpi-health` use.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/**
 * List immediate child basenames of a directory via `find`, for the same
 * reason `catFile` shells out to `cat`: Deno's sandbox demands
 * `--allow-all` for `/sys` directory enumeration even though the
 * directories are world-readable.
 */
async function listDirNames(path: string): Promise<string[]> {
  const cmd = new Deno.Command("find", {
    args: [path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\n"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `find ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).split("\n").filter((l) =>
    l.length > 0
  );
}

/** Result of the hardware guard every method runs before doing real work. */
export interface PiHardwareInfo {
  /** `/proc/device-tree/model`, NUL byte stripped. */
  model: string;
}

/** Hardware guard every method calls before writing any resource. Refuses to run on non-Pi hardware. */
export async function assertRaspberryPiHardware(): Promise<PiHardwareInfo> {
  let rawModel: string;
  try {
    rawModel = await catFile("/proc/device-tree/model");
  } catch (error) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `is missing or unreadable (${
          error instanceof Error ? error.message : String(error)
        }).`,
    );
  }
  // The kernel reports this value NUL-terminated, not newline-terminated.
  const model = rawModel.replace(/\0+$/, "").trim();
  if (!model.includes("Raspberry Pi")) {
    throw new Error(
      `This model requires Raspberry Pi hardware: /proc/device-tree/model ` +
        `reports "${model}", which does not contain "Raspberry Pi".`,
    );
  }
  return { model };
}

/**
 * Find a hwmon device directory by its `name` file, e.g. "pwmfan". hwmon
 * indices are enumeration-order dependent and shift across boots and
 * kernel updates — never hardcode `hwmonN`, always search by name.
 */
export async function findHwmonDeviceByName(
  hwmonBasePath: string,
  targetName: string,
): Promise<string | null> {
  const entries = await listDirNames(hwmonBasePath);
  for (const entry of entries) {
    const devicePath = `${hwmonBasePath}/${entry}`;
    let name: string;
    try {
      name = await catFile(`${devicePath}/name`);
    } catch {
      continue;
    }
    if (name === targetName) return devicePath;
  }
  return null;
}

/**
 * Find a `/sys/class/thermal/cooling_deviceN` directory by its `type` file,
 * e.g. "pwm-fan". Same enumeration-order caveat as hwmon indices.
 */
export async function findCoolingDeviceByType(
  thermalBasePath: string,
  targetType: string,
): Promise<string | null> {
  const entries = await listDirNames(thermalBasePath);
  for (const entry of entries) {
    if (!entry.startsWith("cooling_device")) continue;
    const devicePath = `${thermalBasePath}/${entry}`;
    let type: string;
    try {
      type = await catFile(`${devicePath}/type`);
    } catch {
      continue;
    }
    if (type === targetType) return devicePath;
  }
  return null;
}

/** Parse an integer sysfs attribute, throwing rather than silently defaulting to 0 on garbage. */
export function parseSysfsInt(text: string, fieldName: string): number {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Could not parse ${fieldName} as an integer: "${text}"`);
  }
  return value;
}

/** PWM duty cycle (0-255) as a percentage, one decimal place. */
export function pwmDutyToPercent(pwmDuty: number): number {
  return Math.round((pwmDuty / 255) * 1000) / 10;
}

const GlobalArgsSchema = z.object({
  hwmonBasePath: z.string().default("/sys/class/hwmon").describe(
    "Base sysfs path to search for the fan's hwmon device.",
  ),
  thermalBasePath: z.string().default("/sys/class/thermal").describe(
    "Base sysfs path to search for the fan's cooling_device.",
  ),
  fanHwmonName: z.string().default("pwmfan").describe(
    'The hwmon "name" file value identifying the fan device. Confirmed as ' +
      '"pwmfan" on a Raspberry Pi 5 with the official case; override if a ' +
      "different case/fan reports a different name.",
  ),
  fanCoolingDeviceType: z.string().default("pwm-fan").describe(
    'The thermal cooling_device "type" file value identifying the fan\'s ' +
      "discrete cooling state. Optional signal — missing/mismatched " +
      "doesn't fail the method, just leaves coolingState/maxCoolingState null.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CoolingSchema = z.object({
  rpm: z.number().describe(
    "Tachometer reading from fan1_input. Zero is a normal reading when " +
      "pwmDuty is also zero (fan intentionally stopped) — see the stalled " +
      "field for the actual alarm condition.",
  ),
  pwmDuty: z.number().describe("Raw PWM duty cycle from pwm1, range 0-255."),
  pwmPercent: z.number().describe("pwmDuty expressed as a 0-100 percentage."),
  stalled: z.boolean().describe(
    "True when rpm == 0 while pwmDuty > 0 — the fan has been commanded to " +
      "spin but the tachometer reports it isn't. This is the alarm " +
      "condition; rpm == 0 with pwmDuty == 0 is normal and healthy.",
  ),
  coolingState: z.number().nullable().describe(
    "Discrete cooling step (cur_state) from the matching thermal " +
      "cooling_device. Null when no cooling_device with the configured " +
      "fanCoolingDeviceType was found — a supplementary signal, its " +
      "absence doesn't block the primary rpm/pwm reading.",
  ),
  maxCoolingState: z.number().nullable().describe(
    "Highest valid cooling step (max_state). Null under the same " +
      "condition as coolingState.",
  ),
  deviceName: z.string().describe(
    "The hwmon device's own name file value (matches fanHwmonName).",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

/** Model definition for `@aaronge/rpi-cooling` — Pi official-case PWM fan telemetry. */
export const model = {
  type: "@aaronge/rpi-cooling",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    cooling: {
      description:
        "PWM fan RPM, duty cycle, and discrete cooling state from sysfs " +
        "hwmon/thermal. Catches a fan that's been commanded to spin but " +
        "the tachometer reports it isn't.",
      schema: CoolingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },
  methods: {
    readCooling: {
      description:
        "Locate the fan's hwmon device by name and read fan1_input/pwm1, " +
        "then locate its cooling_device by type and read cur_state/" +
        "max_state (optional), and write the cooling resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await assertRaspberryPiHardware();
        const capturedAt = new Date().toISOString();
        const {
          hwmonBasePath,
          thermalBasePath,
          fanHwmonName,
          fanCoolingDeviceType,
        } = context.globalArgs;

        context.logger.info(
          "Searching {hwmonBasePath} for hwmon device named {fanHwmonName}",
          { hwmonBasePath, fanHwmonName },
        );
        const hwmonPath = await findHwmonDeviceByName(
          hwmonBasePath,
          fanHwmonName,
        );
        if (hwmonPath === null) {
          throw new Error(
            `No hwmon device named "${fanHwmonName}" found under ` +
              `${hwmonBasePath}. Set the fanHwmonName global argument if ` +
              `this machine's fan reports a different name.`,
          );
        }

        const rpm = parseSysfsInt(
          await catFile(`${hwmonPath}/fan1_input`),
          "fan1_input",
        );
        const pwmDuty = parseSysfsInt(
          await catFile(`${hwmonPath}/pwm1`),
          "pwm1",
        );
        const pwmPercent = pwmDutyToPercent(pwmDuty);
        const stalled = rpm === 0 && pwmDuty > 0;

        if (stalled) {
          context.logger.warn(
            "Fan stalled: rpm=0 while pwmDuty={pwmDuty} ({pwmPercent}%) — " +
              "commanded to spin but the tachometer reports it isn't",
            { pwmDuty, pwmPercent },
          );
        }

        context.logger.info(
          "Searching {thermalBasePath} for cooling_device with type {fanCoolingDeviceType}",
          { thermalBasePath, fanCoolingDeviceType },
        );
        const coolingDevicePath = await findCoolingDeviceByType(
          thermalBasePath,
          fanCoolingDeviceType,
        );
        let coolingState: number | null = null;
        let maxCoolingState: number | null = null;
        if (coolingDevicePath === null) {
          context.logger.warn(
            "No cooling_device with type {fanCoolingDeviceType} found " +
              "under {thermalBasePath}; coolingState/maxCoolingState will " +
              "be null — rpm/pwm reading is unaffected",
            { fanCoolingDeviceType, thermalBasePath },
          );
        } else {
          coolingState = parseSysfsInt(
            await catFile(`${coolingDevicePath}/cur_state`),
            "cur_state",
          );
          maxCoolingState = parseSysfsInt(
            await catFile(`${coolingDevicePath}/max_state`),
            "max_state",
          );
        }

        context.logger.info(
          "Captured cooling state: rpm={rpm} pwmPercent={pwmPercent} stalled={stalled}",
          { rpm, pwmPercent, stalled },
        );

        const handle = await context.writeResource("cooling", "cooling", {
          rpm,
          pwmDuty,
          pwmPercent,
          stalled,
          coolingState,
          maxCoolingState,
          deviceName: fanHwmonName,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
