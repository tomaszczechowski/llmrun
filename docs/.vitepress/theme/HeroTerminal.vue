<script setup lang="ts">
import { withBase } from "vitepress";
</script>

<template>
    <div class="hero-terminal">
        <img
            :src="withBase('/hero-terminal.svg')"
            alt="Terminal showing an llmrun up session: fast-7b provisioned on a g6.xlarge, SSM tunnel open, OpenAI-compatible endpoint live at localhost:8000"
            width="760"
            height="460"
        />
    </div>
</template>

<style scoped>
.hero-terminal {
    margin-top: 44px;
    display: flex;
    justify-content: center;
}

.hero-terminal img {
    display: block;
    width: min(100%, 760px);
    height: auto;
}

@media (max-width: 640px) {
    .hero-terminal {
        margin-top: 32px;
    }
}
</style>
