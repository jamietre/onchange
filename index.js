'use strict'

var kill = require('tree-kill')
var path = require('path')
var resolve = require('path').resolve
var exec = require('child_process').exec
var spawn = require('cross-spawn').spawn
var chokidar = require('chokidar')
var arrify = require('arrify')
var os = require('os')
var throttle = require('lodash.throttle')

var echo = process.execPath + ' ' + resolve(__dirname, 'echo.js')

var killRetryDelay = 500

module.exports = function (match, command, args, opts) {
  opts = opts || {}

  var matches = arrify(match).map(function(match) {
    var parts = match.split('/')
    if (parts[0] === '~') {
      parts[0] = os.homedir()
    }
    return path.resolve(process.cwd(), parts.join('/'))
  })

  var initial = !!opts.initial
  var wait = !!opts.wait
    var cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()
  var stdout = opts.stdout || process.stdout
  var stderr = opts.stderr || process.stderr
  var delay = Number(opts.delay) || 0
  var killRetry = Number(opts.killRetry) || 0
  var killSignal = opts.killSignal || 'SIGTERM'
  var outpipe = typeof opts.outpipe === 'string' ? outpipetmpl(opts.outpipe) : undefined

  if (!command && !outpipe) {
    throw new TypeError('Expected "command" and/or "outpipe" to be specified')
  }

  var childOutpipe
  var childCommand
  var pendingOpts
  var pendingTimeout
  var exitTimeout
  var pendingExit = false
  var killRetries

  // Convert arguments to templates
  var tmpls = args ? args.map(tmpl) : []
  console.log("Matches: " + matches)
  var watcher = chokidar.watch(matches, {
    cwd: cwd,
    ignored: opts.exclude || [],
    usePolling: opts.poll === true || typeof opts.poll === 'number',
    interval: typeof opts.poll === 'number' ? opts.poll : undefined
  })

  // Logging
  var log = opts.verbose ? function log (message) {
    stdout.write('onchange: ' + message + '\n')
  } : function () {}

  /**
   * Run when the script exits.
   */
  function onexit () {
    if (childOutpipe || childCommand) {
      return
    }

    pendingExit = false

    if (pendingOpts) {
      if (pendingTimeout) {
        clearTimeout(pendingTimeout)
      }

      if (delay > 0) {
        pendingTimeout = setTimeout(function () {
          cleanstart(pendingOpts)
        }, delay)
      } else {
        cleanstart(pendingOpts)
      }
    }
  }

  /**
   * Run on fresh start (after exists, clears pending args).
   */
  function cleanstart (args) {
    pendingOpts = null
    pendingTimeout = null

    return start(args)
  }

  function killTask(retryNumber) {
    retryNumber = retryNumber || 0

    if (childCommand) {
      log('killing command ' + childCommand.pid + ' and restarting')
      kill(childCommand.pid, killSignal)
    }

    if (childOutpipe) {
      log('killing outpipe ' + childOutpipe.pid + ' and restarting')
      killTask(childOutpipe.pid, killSignal)
    }

    if (killRetry && retryNumber < killRetry) {
      retryNumber++
      exitTimeout = setTimeout(function() {
        if (!pendingExit) return;
        log("process hasn't exited, retry #" + retryNumber)

        killTask(retryNumber);
      }, killRetryDelay * (retryNumber))
    }
  }
  /**
   * Start the script.
   */
  function start (opts) {

    // Set pending options for next execution.
    if (childOutpipe || childCommand) {
      pendingOpts = opts

      if (!pendingExit) {
        pendingExit = true
        if (wait) {
          log('waiting for process and restarting')
        } else {
          killTask()
        }
      }
    }

    if (pendingTimeout || pendingOpts) {
      return
    }

    if (outpipe) {
      var filtered = outpipe(opts)

      log('executing outpipe "' + filtered + '"')

      childOutpipe = exec(filtered, {
        cwd: cwd
      })

      // Must pipe stdout and stderr.
      childOutpipe.stdout.pipe(stdout)
      childOutpipe.stderr.pipe(stderr)

      childOutpipe.on('exit', function (code, signal) {
        if (exitTimeout) {
          clearTimeout(exitTimeout)
        }

        log('outpipe ' + (code == null ? 'exited with ' + signal : 'completed with code ' + code))

        childOutpipe = null

        return onexit()
      })
    }

    if (command) {
      // Generate argument strings from templates.
      var filtered = tmpls.map(function (tmpl) {
        return tmpl(opts)
      })

      log('executing command "' + [command].concat(filtered).join(' ') + '"')

      childCommand = spawn(command, filtered, {
        cwd: cwd,
        stdio: ['ignore', childOutpipe ? childOutpipe.stdin : stdout, stderr]
      })

      childCommand.on('exit', function (code, signal) {
        log('command ' + (code == null ? 'exited with ' + signal : 'completed with code ' + code))

        childCommand = null

        return onexit()
      })
    } else {
      // No data to write to `outpipe`.
      childOutpipe.stdin.end()
    }
  }

    var startThrottled = delay ? throttle(start, delay) : start

  watcher.on('ready', function () {
    log('watching ' + matches.join(', '))

    // Execute initial event, without changed options.
    if (initial) {
      start({ event: '', changed: '' })
    }

    // For any change, creation or deletion, try to run.
    // Restart if the last run is still active.
    watcher.on('all', function (event, changed) {
      // Log the event and the file affected
      log(event + ' to ' + changed)

      startThrottled({ event: event, changed: changed })
    })
  })

  watcher.on('error', function (error) {
    log('watcher error: ' + error)
  })
}

// Double mustache template generator.
function tmpl (str) {
  return function (data) {
    return str.replace(/{{([^{}]+)}}/g, function (_, key) {
      return data[key]
    })
  }
}

// Template generator for `outpipe` option.
function outpipetmpl (str) {
  var value = str.trim()

  if (value.charAt(0) === '|' || value.charAt(0) === '>') {
    return tmpl(echo + ' ' + value)
  }

  return tmpl(value)
}
