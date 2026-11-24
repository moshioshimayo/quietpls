import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { createWidgetAnimator, STATE_BOUNDS, WIDGET_INSETS, TOTAL_FRAMES, easeOutCubic, calculateTargetBounds, interpolateBounds } = require("../../widget-animator");
const { createWidgetStateMachine } = require("../../widget-state-machine");
afterEach(() => vi.useRealTimers());
function mockWindow(bounds = {x:380,y:40,width:240,height:94}) {
  let destroyed = false;
  return { getBounds: () => ({...bounds}), setBounds: vi.fn(b => Object.assign(bounds,b)), isDestroyed: () => destroyed, destroy: () => { destroyed=true; } };
}
describe("floating window geometry and motion", () => {
  it("reserves shadow margins around a 176 × 30 pill and 304 pt panels", () => {
    expect(STATE_BOUNDS.compact).toEqual({width:240,height:94});
    expect(STATE_BOUNDS.expanded.width).toBe(368);
    expect(STATE_BOUNDS.sessionComplete.width).toBe(368);
    expect(calculateTargetBounds("expanded",500,40)).toEqual({x:132,y:40,width:368,height:330});
    expect(() => calculateTargetBounds("unknown",500,40)).toThrow();
  });
  it("opens without overshoot and ends at the requested bounds", async () => {
    vi.useFakeTimers();
    const win = mockWindow(), a = createWidgetAnimator(win);
    let previous = 0;
    for (let i=0;i<=100;i++) {
      const value=easeOutCubic(i/100);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous=value;
    }
    const done=a.transitionTo("expanded");
    vi.advanceTimersByTime(16*TOTAL_FRAMES);
    await done;
    expect(win.getBounds()).toEqual({x:252,y:40,width:368,height:330});
    a.destroy();
  });
  it("fits changing panel content and keeps it within the display", () => {
    const win=mockWindow({x:800,y:650,width:240,height:94});
    const a=createWidgetAnimator(win,{getWorkArea:()=>({x:0,y:25,width:1024,height:743})});
    a.setReducedMotion(true);
    a.transitionTo("expanded");
    a.setContentHeight(400);
    const b=win.getBounds();
    expect(b.height).toBe(400);
    expect(b.x+b.width-WIDGET_INSETS.right).toBeLessThanOrEqual(1024-22);
    expect(b.y+WIDGET_INSETS.top).toBeGreaterThanOrEqual(25+8);
    expect(b.y+b.height-WIDGET_INSETS.bottom).toBeLessThanOrEqual(768-22);
    a.destroy();
  });
  it("honors Reduce Motion without scheduling an animation", async () => {
    vi.useFakeTimers();
    const win=mockWindow(),a=createWidgetAnimator(win);
    a.setReducedMotion(true);
    await a.transitionTo("expanded");
    expect(vi.getTimerCount()).toBe(0);
    expect(win.getBounds().width).toBe(368);
    a.destroy();
  });
  it("connects and releases the existing state machine", () => {
    vi.useFakeTimers();
    const win=mockWindow(),a=createWidgetAnimator(win),sm=createWidgetStateMachine("compact");
    a.setReducedMotion(true);
    a.connectStateMachine(sm);
    sm.transition("expanded");
    expect(win.getBounds().width).toBe(368);
    a.destroy();
    sm.transition("compact");
    expect(win.getBounds().width).toBe(368);
  });
  it("cancels an in-flight resize and stops safely on destroyed windows", async () => {
    vi.useFakeTimers();
    const win=mockWindow(),a=createWidgetAnimator(win);
    a.transitionTo("expanded");
    vi.advanceTimersByTime(16);
    const done=a.transitionTo("sessionComplete");
    vi.advanceTimersByTime(16*TOTAL_FRAMES);
    await done;
    expect(win.getBounds().height).toBe(300);
    win.destroy();
    await a.transitionTo("compact");
    a.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("interpolates integer bounds", () => {
    expect(interpolateBounds({x:0,y:0,width:240,height:94},{x:10,y:20,width:368,height:330},.5))
      .toEqual({x:5,y:10,width:304,height:212});
  });
});
