// An invisible block that reports the window's width or height (props.dim "w" or "h") for the landscape layout.
import { View, div } from "gpui-kit";
import { props, shared, setShared, run } from "herdr";

export default class Probe extends View {
  render() {
    return div().id("probe").size_full().on_size_change((size, cx) => {
      const dim = props()?.dim, v = Math.round(dim === "w" ? size.width : size.height), cur = shared("glass.window") ?? {};
      if (!dim || !v || Math.abs((cur[dim] ?? 0) - v) < 16) return;
      setShared("glass.window", { ...cur, [dim]: v });
      run("glass-tabs.arrange");
    });
  }
}
