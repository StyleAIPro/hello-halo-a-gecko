              {/* Claude Source Selection */}
              <label className="block text-sm text-muted-foreground mb-2">{t('Claude Source')}</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="claudeSource"
                    value="local"
                    checked={claudeSource === 'local'}
                    onChange={(e) => {
                      setClaudeSource('local')
                      // When switching to local mode, clear remote server selection
                      setRemoteServerId('')
                    }}
                    />
                    <span>{t('Local')}</span>
                  </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="claudeSource"
                    value="remote"
                    checked={claudeSource === 'remote'}
                    onChange={(e) => setClaudeSource('remote')}
                    />
                    <span>{t('Remote')}</span>
                </label>
              </div>

              {/* Storage Location Selection - only for local mode */}
              {claudeSource === 'local' && (
                <>
                  <label className="block text-sm text-muted-foreground mb-4">{t('Storage Location')}</label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="storageType"
                      value="default"
                      checked={!useCustomPath}
                      onChange={() => {
                        setUseCustomPath(false)
                        setTimeout(() => {
                          spaceNameInputRef.current?.focus()
                        }, 100)
                      }}
                      disabled={isWebMode}
                      className="w-4 h-4 text-primary"
                    />
                    <span>{t('Default Location')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="storageType"
                      value="custom"
                      checked={useCustomPath}
                      onChange={() => !isWebMode && setUseCustomPath(true)}
                      disabled={isWebMode}
                      className="w-4 h-4 text-primary"
                    />
                    <span>{t('Custom Location')}</span>
                  </label>

                  {/* Default path display */}
                  {!useCustomPath && (
                    <div className="mb-4">
                      <label className="block text-sm">{t('Default Path')}</label>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">{shortenPath(defaultPath)}</span>
                      </div>
                    </div>
                  )}

                  {/* Custom path input */}
                  {useCustomPath && (
                    <div className="mb-4">
                      <label className="block text-sm">{t('Custom Path')}</label>
                      <input
                        type="text"
                        value={customPath || ''}
                        onChange={(e) => setCustomPath(e.target.value)}
                        placeholder={t('Enter custom path...')}
                        disabled={isWebMode}
                        className="w-full px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                      />
                    </div>
                  )}

                  {!isWebMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        handleSelectFolder()
                      }}
                      className="px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/80 rounded-md flex items-center gap-1.5 transition-colors"
                    >
                      <FolderOpen className="w-3 h-3" />
                      {t('Browse')}
                    </button>
                  )}
                </>
              )}

              {/* Remote Server Configuration - only for remote mode */}
              {claudeSource === 'remote' && (
                <div className="mb-4">
                  <label className="block text-sm text-muted-foreground mb-4">{t('Remote Server')}</label>
                  <select
                    value={remoteServerId}
                    onChange={(e) => setRemoteServerId(e.target.value)}
                    className="w-full px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                  >
                    <option value="">{t('Select server...')}</option>
                    {remoteServers.map((server: RemoteServer) => (
                      <option key={server.id} value={server.id}>
                        {server.name} {server.status === 'connected' ? ` (${t('Connected')})` : ` (${t('Disconnected')})`}
                      </option>
                      ))}
                  </select>

                  <label className="block text-sm mt-4">{t('Working Directory (Remote)')}</label>
                  <input
                    type="text"
                    value={remotePath}
                    onChange={(e) => setRemotePath(e.target.value)}
                    placeholder="/home"
                    className="w-full px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{t('Default: /home')}</p>
                </div>
              )}
