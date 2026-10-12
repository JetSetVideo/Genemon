<script setup lang="ts">
type User = {
  id: string
  name: string
  sex: string
  age: number
  nationality: string
  job: string
  hobbies: string[]
  biometrics: { height_cm: number; weight_kg: number }
  influence_profile: Record<string, number>
}

const users = ref<User[]>([])
const selectedUserId = ref<string | null>(null)
const selectedUser = computed(() => users.value.find(u => u.id === selectedUserId.value) || null)

function loadUsers() {
  const mod = (import.meta as any).glob('~/data/users.json', { eager: true, import: 'default' })
  const firstKey = Object.keys(mod)[0]
  const arr = (mod[firstKey] || []) as User[]
  users.value = arr
  if (!selectedUserId.value && arr.length) selectedUserId.value = arr[0].id
}

onMounted(loadUsers)
</script>

<template>
  <div class="col" style="height:100%">
    <div class="row">
      <div class="card" style="flex:1">
        <div class="section-title">Users</div>
        <div class="divider" />
        <ul style="list-style:none; padding:0; margin:0; display:grid; grid-template-columns: repeat(auto-fill, minmax(220px,1fr)); gap:12px;">
          <li v-for="u in users" :key="u.id">
            <button class="card" style="width:100%; text-align:left; cursor:pointer" @click="selectedUserId = u.id">
              <div style="font-weight:600">{{ u.name }}</div>
              <div style="opacity:.7; font-size:12px">{{ u.nationality }} • {{ u.job }}</div>
            </button>
          </li>
        </ul>
      </div>
      <div class="card" style="flex:1; min-width:320px">
        <div class="section-title">User Inspector</div>
        <div class="divider" />
        <div v-if="selectedUser">
          <div class="row"><strong style="min-width:120px">Name</strong><span>{{ selectedUser.name }}</span></div>
          <div class="row"><strong style="min-width:120px">Sex</strong><span>{{ selectedUser.sex }}</span></div>
          <div class="row"><strong style="min-width:120px">Age</strong><span>{{ selectedUser.age }}</span></div>
          <div class="row"><strong style="min-width:120px">Nationality</strong><span>{{ selectedUser.nationality }}</span></div>
          <div class="row"><strong style="min-width:120px">Job</strong><span>{{ selectedUser.job }}</span></div>
          <div class="row"><strong style="min-width:120px">Hobbies</strong><span>{{ selectedUser.hobbies.join(', ') }}</span></div>
          <div class="row"><strong style="min-width:120px">Biometrics</strong><span>{{ selectedUser.biometrics.height_cm }} cm, {{ selectedUser.biometrics.weight_kg }} kg</span></div>
          <div class="row"><strong style="min-width:120px">Influence</strong>
            <span>
              <template v-for="(v,k,i) in selectedUser.influence_profile" :key="k">
                <span>{{ k }}: {{ v }}</span><span v-if="i < Object.keys(selectedUser.influence_profile).length-1">, </span>
              </template>
            </span>
          </div>
        </div>
        <div v-else>
          <em>No user selected.</em>
        </div>
      </div>
    </div>
  </div>
</template>


