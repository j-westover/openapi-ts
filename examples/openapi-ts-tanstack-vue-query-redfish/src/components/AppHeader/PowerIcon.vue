<script setup lang="ts">
/**
 * Power-state SVG icon — ported verbatim from the downstream
 * `webui-vue/src/components/AppHeader/PowerIcon.vue`. The shape paths,
 * status taxonomy, and blink animations are identical; only the
 * colour bindings have been moved from Bootstrap theme variables to
 * Tailwind `currentColor`-driven classes so it slots into a Tailwind
 * codebase without an SCSS pipeline.
 */
import { computed } from 'vue';

export type PowerStatus = 'on' | 'off' | 'on blink' | 'on blink 1Hz' | 'secondary';

interface Props {
  ariaHidden?: boolean;
  status: PowerStatus;
}

const props = withDefaults(defineProps<Props>(), {
  ariaHidden: false,
});

const colorClass = computed(() => {
  if (props.status === 'on' || props.status.startsWith('on ')) return 'text-green-400';
  if (props.status === 'off') return 'text-red-400';
  return 'text-gray-400';
});

const animationClass = computed(() => {
  if (props.status === 'on blink') return 'power-blink';
  if (props.status === 'on blink 1Hz') return 'power-blink-1hz';
  return '';
});

const ariaLabel = computed(() => {
  switch (props.status) {
    case 'on':
      return 'Power on';
    case 'off':
      return 'Power off';
    case 'on blink':
      return 'Power turning on';
    case 'on blink 1Hz':
      return 'Power paused';
    case 'secondary':
    default:
      return 'Power status unknown';
  }
});
</script>

<template>
  <span class="power-icon inline-flex" :class="colorClass">
    <svg
      :aria-hidden="ariaHidden"
      :aria-label="ariaLabel"
      :class="[status, animationClass]"
      height="24"
      viewBox="0 0 32 32"
      width="24"
    >
      <g data-id="power-on">
        <path
          d="M22.5,5.74l-1,1.73a11,11,0,1,1-11,0l-1-1.73a13,13,0,1,0,13,0Z"
          fill="currentColor"
          transform="translate(0)"
        />
        <rect fill="currentColor" height="14" width="2" x="15" y="2" />
      </g>
      <g data-id="power-off">
        <path
          d="M29,17 a11,11,0,1,0,-26,0 a11,11,0,1,0,26,0 M27,17 a10,10,0,1,1,-22,0 a10,10,0,1,1,22,0 Z"
          fill="currentColor"
          transform="translate(0)"
        />
        <rect fill="currentColor" height="14" stroke="none" width="2" x="15" y="10" />
      </g>
    </svg>
  </span>
</template>

<style scoped>
.power-icon svg > [data-id='power-off'] {
  display: none;
}
.power-icon svg > [data-id='power-on'] {
  display: initial;
}

.power-icon svg.off > [data-id='power-on'],
.power-icon svg.secondary > [data-id='power-on'] {
  display: none;
}
.power-icon svg.off > [data-id='power-off'],
.power-icon svg.secondary > [data-id='power-off'] {
  display: initial;
}

/* Blink animation - normal speed (1.0s) */
.power-icon svg.power-blink g rect,
.power-icon svg.power-blink g path {
  animation: power-blink 1s infinite;
}

/* 1Hz faster blink (0.25s) */
.power-icon svg.power-blink-1hz g rect,
.power-icon svg.power-blink-1hz g path {
  animation: power-blink 0.25s infinite;
}

@keyframes power-blink {
  0%,
  100% {
    fill: none;
  }
  60% {
    fill: currentColor;
  }
}
</style>
