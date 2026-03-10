#!/usr/bin/env node

/**
 * 简单的 SSH 连接测试脚本
 * 直接使用 ssh2 库测试远程服务器连接
 */

const { Client: SSHClient } = require('ssh2')

// 读取配置
function loadRemoteServers() {
  const fs = require('fs')
  const configPath = process.env.HALO_DATA_DIR
    ? `${process.env.HALO_DATA_DIR}/config.json`
    : `${process.env.HOME}/.halo-dev/config.json`

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

// 测试 SSH 连接和命令执行
function testSSH(server, command) {
  console.log('\n测试 SSH 执行')
  console.log('================================')
  console.log(`服务器: ${server.name}`)
  console.log(`命令: ${command}`)
  console.log('')

  return new Promise((resolve, reject) => {
    const conn = new SSHClient()

    conn.on('ready', () => {
      console.log('[1/3] SSH 连接成功')
      console.log('[2/3] 执行命令...')

      conn.exec(command, (err, stream) => {
        if (err) {
          console.error('执行命令失败:', err)
          conn.end()
          return reject(err)
        }

        let output = ''
        let errorOutput = ''

        stream.on('data', (data) => {
          output += data.toString()
        })

        stream.stderr.on('data', (data) => {
          errorOutput += data.toString()
        })

        stream.on('close', () => {
          console.log('[3/3] 命令执行完成')
          console.log('')
          console.log('输出:')
          console.log('--------------------------------')
          console.log(output)

          if (errorOutput) {
            console.log('')
            console.log('错误:')
            console.log('--------------------------------')
            console.log(errorOutput)
          }

          conn.end()
          resolve({ output, errorOutput })
        })
      })
    })

    conn.on('error', (err) => {
      console.error('SSH 连接失败:', err.message)
      reject(err)
    })

    conn.connect({
      host: server.host,
      port: server.sshPort,
      username: server.username,
      password: server.password,
      readyTimeout: 20000
    })
  })
}

// 主函数
async function main() {
  console.log('=================================')
  console.log('SSH 连接测试工具')
  console.log('================================')
  console.log('')

  // 读取配置
  const servers = loadRemoteServers()
  if (servers.length === 0) {
    console.error('没有配置远程服务器')
    console.log('请先在 Halo 应用中添加远程服务器')
    process.exit(1)
  }

  // 显示服务器列表
  listServers(servers)

  // 获取用户输入
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('用法:')
    console.log('  node scripts/test-ssh.js <服务器索引> <命令>')
    console.log('')
    console.log('示例:')
    console.log('  node scripts/test-ssh.js 1 "echo hello"')
    console.log('  node scripts/test-ssh.js 1 "pwd"')
    console.log('  node scripts/test-ssh.js 1 "date"')
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
  try {
    await testSSH(server, command)
    console.log('\n测试完成！')
  } catch (error) {
    console.error('测试失败:', error.message)
    process.exit(1)
  }
}

main()
