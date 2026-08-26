# @aaronge/rpi-cooling

Raspberry Pi official-case PWM fan telemetry — tachometer RPM, PWM duty
cycle, and discrete thermal cooling state, all from sysfs — as a typed,
versioned Swamp model. A fan that spins but no longer moves air is a real
failure mode that nothing on the system warns about; correlating RPM
against the fan's own commanded duty cycle over time catches it. Zero
privileges: every source (`hwmon`, `/sys/class/thermal`) is world-readable.
Read-only — this model never writes `pwm1` or otherwise changes the fan's
speed.

## Installation

```sh
swamp extension pull @aaronge/rpi-cooling
```

## Usage

```sh
swamp model create @aaronge/rpi-cooling rpi-local

swamp model method run rpi-local readCooling
```

The method writes one resource: `cooling`. Every field is described — run
`swamp model type describe @aaronge/rpi-cooling` to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("rpi-local", "cooling").attributes.stalled == false
```

## Global arguments

| Arg                    | Default              | Notes                                                          |
| ----------------------- | --------------------- | ---------------------------------------------------------------- |
| `hwmonBasePath`         | `"/sys/class/hwmon"`  | Base path searched for the fan's hwmon device.                   |
| `thermalBasePath`       | `"/sys/class/thermal"`| Base path searched for the fan's cooling_device.                 |
| `fanHwmonName`          | `"pwmfan"`            | The hwmon `name` file value identifying the fan. Confirmed as `"pwmfan"` on a Raspberry Pi 5 with the official case. |
| `fanCoolingDeviceType`  | `"pwm-fan"`           | The thermal `cooling_device` `type` file value. Optional signal — missing doesn't fail the method. |

## How it works

- **`cooling`** — locates the fan's `hwmon` device by reading each
  device's `name` file rather than assuming a fixed `hwmonN` index (indices
  are enumeration-order dependent and shift across boots and kernel
  updates), then reads `fan1_input` (RPM) and `pwm1` (duty cycle, 0-255,
  hoisted to `pwmPercent`). Separately, and non-fatally, it locates a
  matching `/sys/class/thermal/cooling_deviceN` by its `type` file to read
  the discrete cooling step (`cur_state`/`max_state`) — a supplementary
  signal, so its absence degrades `coolingState`/`maxCoolingState` to
  `null` with a warning rather than failing the whole read.

  `stalled` is the field this whole extension exists for: `true` when
  `rpm == 0` while `pwmDuty > 0` — the fan has been commanded to spin but
  the tachometer reports it isn't. `rpm == 0` alongside `pwmDuty == 0` is
  normal and healthy (the fan is intentionally stopped), so `stalled` — not
  a bare RPM threshold — is the field a workflow should assert on.

Refuses to run on non-Pi hardware — checking `/proc/device-tree/model`
names a Raspberry Pi — before writing anything.

## Workflow

The extension ships an `rpi-cooling` workflow: a `collect` job runs
`readCooling`, an `assert` job fails the run when `stalled == true`
(`allowFailure: false` — a stalled fan is exactly the signal this model
exists to catch), and a `report` job prints a one-screen summary regardless
of whether the assert job passed. Scheduled every 5 minutes via
`trigger.schedule`, the same cadence as the telemetry-focused
`@aaronge/host-health`/`@aaronge/rpi-health` workflows — a stalled fan is
time-sensitive in a way boot configuration (`@aaronge/rpi-boot-config`)
isn't.

Pairs naturally with `@aaronge/rpi-health`'s core temperature: a future
cross-cutting `thermal-integrity` workflow asserting "if temperature > 60°C
then `rpi-cooling` rpm > 0" catches a dead fan before it becomes a thermal
event — not yet built, tracked alongside the rest of the Raspberry Pi
extension family's cross-cutting workflows.

## License

MIT — see LICENSE for details.
