/** Observable restart conditions, not a claim that the stub plays CSS. */
export type MotionMutation =
  | { readonly type: 'detach'; readonly nodes: readonly unknown[] }
  | { readonly type: 'class'; readonly node: unknown; readonly before: string; readonly after: string }

interface MotionNode {
  readonly node: unknown
  readonly classes: readonly string[]
  readonly attributes: ReadonlyMap<string, string>
  readonly children: readonly MotionNode[]
}

function matching(root: MotionNode, selector: string): MotionNode[] {
  const match = selector.startsWith('.')
    ? root.classes.includes(selector.slice(1))
    : root.attributes.get('id') === selector.slice(1)
  return [...(match ? [root] : []), ...root.children.flatMap((child) => matching(child, selector))]
}

/** Sampling returns the actual node; `replacements` excludes its initial mount. */
export function trackIdentity(root: () => MotionNode, selector: string) {
  let previous: unknown
  let sampled = false
  let replacements = 0
  return {
    sample(): unknown {
      const current = matching(root(), selector)[0]?.node
      if (sampled && current !== previous) replacements += 1
      previous = current
      sampled = true
      return current
    },
    get replacements(): number { return replacements },
  }
}

/** Watches detach/reinsert and animation-class reactivation, including between samples. */
export function trackAnimationStarts(
  root: () => MotionNode,
  selector: string,
  subscribe: (listener: (event: MotionMutation) => void) => () => void,
  animationClass?: string,
) {
  let detaches = 0
  let classStarts = 0
  const dispose = subscribe((event) => {
    const nodes = matching(root(), selector).map((match) => match.node)
    if (event.type === 'detach') {
      detaches += nodes.filter((node) => event.nodes.includes(node)).length
    } else if (animationClass && nodes.includes(event.node)
      && !event.before.split(/\s+/).includes(animationClass)
      && event.after.split(/\s+/).includes(animationClass)) {
      classStarts += 1
    }
  })
  return {
    dispose,
    get detaches(): number { return detaches },
    get classStarts(): number { return classStarts },
    get starts(): number { return detaches + classStarts },
  }
}
