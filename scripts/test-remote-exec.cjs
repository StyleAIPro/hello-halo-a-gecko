#!/usr/bin/env node

/**
 * 远程执行测试脚本
 * 直接测试 SSHManager 的功能，无需通过前端
 */

const path = require('path')
const { SSHManager } = require('../src/main/services/remote-ssh/ssh-manager.ts')

// 读取配置
function loadRemoteServers() {
  const fs = require('fs')
  const configPath = process.env.AICO_BOT_DATA_DIR
    ? path.join(process.env.AICO_BOT_DATA_DIR, 'config.json')
    : path.join(process.env.HOME, '.aico-bot-dev', 'config.json')

  if (!fs.existsSync(configPath)) {
    console.error('配置文件不存在:', configPath)
    process.exit(1)
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  return config.remoteServers || []
}

// 显示服务器列表
function listServers(servers) {
  console.log('\n可用服务器:')
  console.log('================================')
  servers.forEach((server, index) => {
    console.log(`${index + 1}. ${server.name}`)
    console.log(`   ID: ${server.id}`)
    console.log(`   主机: ${server.host}:${server.sshPort}`)
    console.log(`   状态: ${server.status}`)
    console.log('')
  })
}

// 测试 SSH 执行
async function testSSH(server, command) {
  console.log('\n测试 SSH 执行')
  console.log('================================')
  console.log(`服务器: ${server.name}`)
  console.log(`命令: ${command}`)
  console.log('')

  const sshManager = new SSHManager(server, {
    host: server.host,
    port: server.sshPort,
    username: server.username,
    password: server.password
  })

  try {
    // 连接
    console.log('[1/3] 连接到服务器...')
    await sshManager.connect()

    console.log('[2/3] 执行命令...')
    const result = await sshManager.executeCommand(command)

    console.log('[3/3] 命令执行完成')
    console.log('')
    console.log('输出:')
    console.log('--------------------------------')
    console.log(result.stdout)
    console.log('')

    if (result.stderr) {
      console.log('错误:')
      console.log('--------------------------------')
      console.log(result.stderr)
    }
  } catch (error) {
    console.error('测试失败:', error.message)
  } finally {
    // 断开连接
    await sshManager.disconnect()
  }
}

// 主函数
async function main() {
  console.log('=================================')
  console.log('远程执行测试工具')
  console.log('================================')
  console.log('')

  // 读取配置
  const servers = loadRemoteServers()
  if (servers.length === 0) {
    console.error('没有配置远程服务器')
    console.log('请先在 AICO-Bot 应用中添加远程服务器')
    process.exit(1)
  }

  // 显示服务器列表
  listServers(servers)

  // 获取用户输入
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('用法:')
    console.log('  node scripts/test-remote-exec.js <服务器索引> <命令>')
    console.log('')
    console.log('示例:')
    console.log('  node scripts/test-remote-exec.js 1 "echo hello"')
    console.log('  node scripts/test-remote-exec.js 1 "pwd"')
    console.log('  node scripts/test-remote-exec.js 1 "date"')
    console.log('')
    process.exit(0)
  }

  const serverIndex = parseInt(args[0]) - 1
  const command = args.slice(1).join(' ')

  if (serverIndex < 0 || serverIndex >= servers.length) {
    console.error('无效的服务器索引:', args[0])
    process.exit(1)
  }

  const server = servers[serverIndex]

  // 执行测试
  await testSSH(server, command)
}

main().catch(error => {
  console.error('发生错误:', error)
  process.exit(1)
})
