
var process = require('process');
process.env.ALLOW_CONFIG_MUTATIONS = 1;

var md5 = require('MD5');
var os = require('os');
var Collectd = require('collectdout');
var diskspace = require('diskspace');
var perfmon = require('perfmon');
var cpu = require('windows-cpu');
var express = require('express');
var basicAuth = require('connect-basic-auth');
var bodyParser = require('body-parser');
var fs = require('fs');
var cfg = require('config');

var collectwVersion = '<%= pkg.version %>';

var collectwHTTPUser = cfg.get('HttpConfig.login');
var CollectwHTTPPassword = md5(cfg.get('HttpConfig.password'));
var counters = [];
var client;
var path = require('path').dirname(require.main.filename);

var get_perfmon = new pluginPerfmon();

// Initialize configuration directory in the same way that node-config does.
var configDir = cfg.util.initParam('NODE_CONFIG_DIR', process.cwd() + '/config');
if (configDir.indexOf('.') === 0) {
    configDir = process.cwd() + '/' + CONFIG_DIR;
}

var each = function(obj, block) {
  var attr;
  for(attr in obj) {
    if(obj.hasOwnProperty(attr))
      block(attr, obj[attr]);
  }
};

function get_hostname_with_case() {
    var h = cfg.has('Hostname') ? cfg.get('Hostname') : os.hostname();
    var hcase = cfg.has('HostnameCase') ? cfg.get('HostnameCase') : 'default';
    switch(hcase) {
        case 'upper': h = h.toUpperCase(); break;
        case 'lower': h = h.toLowerCase(); break;
    }
    return(h);
}

function get_collectd_servers_and_ports() {
    var servers = cfg.has('Network.servers') ? cfg.get('Network.servers') : {};
    var res = [];
    for (var i in servers) {
        res.push( [ servers[i].hostname, (servers[i].port || 25826) ] );
    }
    return(res);
}

function get_interval() {
    return(cfg.has('Interval') ? (cfg.get('Interval') * 1000) : 10000);
}

function collectd_sanitize(name) {
    return name.replace(/[ -\/\(\)]/g, '_');
}

function pluginPerfmon() {
    var config = {};

    function add_counter(counter, type, p, pi, t, ti) {
        counter = counter.replace(/\\\\/g, '\\');
        if (typeof pi == 'undefined') { pi = ''; }
        if (typeof ti == 'undefined') { ti = ''; }
        if (typeof counters[p+'-'+pi] == 'undefined') {
            counters[p+'-'+pi] = client.plugin(p, pi);
        }

        perfmon(counter, function(err, data) {
            if (typeof data === 'undefined' || typeof data.counters === 'undefined') { return; }
            switch (type) {
                case 'counter':
                    counters[p+'-'+pi].addCounter(t, ti, data.counters[counter]);
                break;
                case 'gauge':
                    counters[p+'-'+pi].setGauge(t, ti, data.counters[counter]);
                break;
            }
        });
    }

    this.configShow = function() {
        return(config);
    };

    this.toString = function() {
        return(JSON.stringify(config));
    };

    this.reloadConfig = function(c) {
        for (var i in c.counters) {
            var pm = c.counters[i];
            if(pm.enable) {
                //FIXME : ensure that pm.* is defined and sanitized
                pm.plugin = collectd_sanitize(pm.plugin);
                pm.plugin_instance = collectd_sanitize(pm.plugin_instance);
                pm.type = collectd_sanitize(pm.type);
                pm.type_instance = collectd_sanitize(pm.type_instance);
                pm.collectdType = 'gauge'; //FIXME : use Collectd Types.db instead of hardcoded gauge.
                config[pm.counter] = pm;
            }
        }
        return(this);
    };

    this.reInit = function() {
        //FIXME : remove all Perfmon counters
        config = {};
        return(this);
    };

    this.monitor = function() {
        for (var i in config) {
            pm = config[i];
            add_counter(pm.counter, pm.collectdType, pm.plugin, pm.plugin_instance, pm.type, pm.type_instance);
        }
        return(this);
    };
}

function get_cpu() {
    var cpus = os.cpus();
    var user = 0;
    var nice = 0;
    var sys = 0;
    var irq = 0;
    var idle = 0;
    
    each(cpus, function (cpu) {
        if (typeof counters['cpu-'+cpu] == 'undefined') {
            counters['cpu-'+cpu] = client.plugin('cpu', cpu);
        }
        counters['cpu-'+cpu].setCounter('cpu', 'user', parseInt(cpus[cpu].times.user) / 10);
        user += parseInt(cpus[cpu].times.user);
        counters['cpu-'+cpu].setCounter('cpu', 'nice', parseInt(cpus[cpu].times.nice) / 10);
        nice += parseInt(cpus[cpu].times.nice);
        counters['cpu-'+cpu].setCounter('cpu', 'system', parseInt(cpus[cpu].times.sys) / 10);
        sys += parseInt(cpus[cpu].times.sys);
        counters['cpu-'+cpu].setCounter('cpu', 'irq', parseInt(cpus[cpu].times.irq) / 10);
        irq += parseInt(cpus[cpu].times.irq);
        counters['cpu-'+cpu].setCounter('cpu', 'idle', parseInt(cpus[cpu].times.idle) / 10);
        idle += parseInt(cpus[cpu].times.idle);
    });
    if (typeof counters['cpu-total'] == 'undefined') {
        counters['cpu-total'] = client.plugin('cpu', 'total');
    }
    counters['cpu-total'].setCounter('cpu', 'user', user / 10 / cpus.length);
    counters['cpu-total'].setCounter('cpu', 'nice', nice / 10 / cpus.length);
    counters['cpu-total'].setCounter('cpu', 'system', sys / 10 / cpus.length);
    counters['cpu-total'].setCounter('cpu', 'irq', irq / 10 / cpus.length);
    counters['cpu-total'].setCounter('cpu', 'idle', idle / 10 / cpus.length);
    counters['cpu-total'].setGauge('nbcpu', '', cpus.length);
}


function get_memory() {
    var plugin = client.plugin('memory', '');
    var free = os.freemem();
    plugin.setGauge('memory', 'free', parseInt(free));
    plugin.setGauge('memory', 'used', parseInt(os.totalmem()) - parseInt(free));
}

function get_df() {
    var disks = ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z'];
    each(disks, function (disk) {
        if (typeof counters['df-'+disks[disk]] == 'undefined') {
            counters['df-'+disks[disk]] = client.plugin('df', disks[disk]);
        }
        diskspace.check(disks[disk], function (total, free, status) {
            if (typeof status != 'undefined' && total > 0) {
                counters['df-'+disks[disk]].setGauge('df_complex', 'reserved', 0 );
                counters['df-'+disks[disk]].setGauge('df_complex', 'free', parseInt(free));
                counters['df-'+disks[disk]].setGauge('df_complex', 'used', (parseInt(total) - parseInt(free)));
            }
        });
    });

}

function get_disk() {
    perfmon.list('PhysicalDisk', function(err, datas) {
        perfmon(datas.counters, function(err, data) {
            var results = [];
            each(data.counters, function (metric, value) {
                var regex = /^PhysicalDisk\((.*)\)\\(.*)/;
                var result = metric.match(regex);
                if (result[1] == '_Total') {
                    disk = 'total';
                } else {
                    disk = result[1].substr(2,1);
                }
                if (typeof results[disk] == 'undefined') {
                    results[disk] = [];
                }
                if (typeof counters['disk-'+disk] == 'undefined') {
                    counters['disk-'+disk] = client.plugin('disk', disk);
                }
                switch(result[2]) {
                    case 'Disk Read Bytes/sec':
                        results[disk].disk_octet_read = value;
                        if (typeof results[disk].disk_octet_write != 'undefined') {
                            counters['disk-'+disk].addCounter('disk_octets', '', [results[disk].disk_octet_read, results[disk].disk_octet_write]);
                            delete results[disk].disk_octet_write;
                        }
                    break;
                    case 'Disk Write Bytes/sec':
                        results[disk].disk_octet_write = value;
                        if (typeof results[disk].disk_octet_read != 'undefined') {
                            counters['disk-'+disk].addCounter('disk_octets', '', [results[disk].disk_octet_read, results[disk].disk_octet_write]);
                            delete results[disk].disk_octet_read;
                        }
                    break;
                    case '% Disk Read Time':
                        results[disk].disk_read_time = Number(value / 100);
                        if (typeof results[disk].disk_write_time != 'undefined') {
                            counters['disk-'+disk].addCounter('disk_time', '', [results[disk].disk_read_time, results[disk].disk_write_time]);
                            delete results[disk].disk_write_time;
                        }
                    break;
                    case '% Disk Write Time':
                        results[disk].disk_write_time = Number(value / 100);
                        if (typeof results[disk].disk_read_time != 'undefined') {
                            counters['disk-'+disk].addCounter('disk_time', '', [results[disk].disk_read_time, results[disk].disk_write_time]);
                            delete results[disk].disk_read_time;
                        }
                    break;
                    case 'Disk Reads/sec':
                        results[disk].disk_read = value;
                        if (typeof results[disk].disk_write != 'undefined') {
                            counters['disk-'+disk].addCounter('disk_ops', '', [results[disk].disk_read, results[disk].disk_write]);
                            delete results[disk].disk_write;
                        }
                    break;
                    case 'Disk Writes/sec':
                        results[disk].disk_write = value;
                        if (typeof results[disk].disk_read != 'undefined') {
                            counters['disk-'+disk].addCounter('disk_ops', '', [results[disk].disk_read, results[disk].disk_write]);
                            delete results[disk].disk_read;
                        }
                    break;
                }
            });
        });
    });
}

function get_interface() {
    perfmon.list('Network Interface', function(err, datas) {
        perfmon(datas.counters, function(err, data) {
            var results = [];
            each(data.counters, function (metric, value) {
                var regex = /^Network Interface\((.*)\)\\(.*)/;
                var result = metric.match(regex);
                interface_name = collectd_sanitize(result[1]);
                var plugin = client.plugin('interface', interface_name);
                if (typeof results[interface_name] == 'undefined') {
                    results[interface_name] = [];
                }
                switch(result[2]) {
                    case 'Bytes Received/sec':
                        results[interface_name].if_octets_rx = value;
                        if (typeof results[interface_name].if_octets_tx != 'undefined') {
                            plugin.addCounter('if_octets', '', [results[interface_name].if_octets_rx, results[interface_name].if_octets_tx]);
                            delete results[interface_name].if_octets_tx;
                        }
                    break;
                    case 'Bytes Sent/sec':
                        results[interface_name].if_octets_tx = value;
                        if (typeof results[interface_name].if_octets_rx != 'undefined') {
                            plugin.addCounter('if_octets', '', [results[interface_name].if_octets_rx, results[interface_name].if_octets_tx]);
                            delete results[interface_name].if_octets_rx;
                        }
                    break;
                    case 'Packets Received/sec':
                        results[interface_name].if_packets_rx = Number(value / 100);
                        if (typeof results[interface_name].if_packets_tx != 'undefined') {
                            plugin.addCounter('if_packets', '', [results[interface_name].if_packets_rx, results[interface_name].if_packets_tx]);
                            delete results[interface_name].if_packets_tx;
                        }
                    break;
                    case 'Packets Sent/sec':
                        results[interface_name].if_packets_tx = Number(value / 100);
                        if (typeof results[interface_name].if_packets_rx != 'undefined') {
                            plugin.addCounter('if_packets', '', [results[interface_name].if_packets_rx, results[interface_name].if_packets_tx]);
                            delete results[interface_name].if_packets_rx;
                        }
                    break;
                    case 'Packets Received Errors':
                        results[interface_name].if_error_rx = value;
                        if (typeof results[interface_name].if_error_tx != 'undefined') {
                            plugin.addCounter('if_errors', '', [results[interface_name].if_error_rx, results[interface_name].if_error_tx]);
                            delete results[interface_name].if_error_tx;
                        }
                    break;
                    case 'Packets Outbound Errors':
                        results[interface_name].if_error_tx = value;
                        if (typeof results[interface_name].if_error_rx != 'undefined') {
                            plugin.addCounter('if_errors', '', [results[interface_name].if_error_rx, results[interface_name].if_error_tx]);
                            delete results[interface_name].if_error_rx;
                        }
                    break;
                }
            });
        });
    });
}

function get_load() {
    var plugin = client.plugin('load', '');
    cpu.totalLoad(function (error, results) {
        if (error) { return; }
        var total = 0;
        each(results ,function(cpunb) {
            total += parseInt(results[cpunb]);
        });
        plugin.setGauge('percent', '', total/results.length);
    });
}

function get_uptime() {
    var plugin = client.plugin('uptime', '');
    plugin.setGauge('uptime', '', os.uptime());
}

function get_process() {
    var plugin = client.plugin('processes', '');
    perfmon('\\Thread(_Total/_Total)\\Context Switches/sec', function(err, data) {
        plugin.addCounter('contextswitch', '', data.counters['\\Thread(_Total/_Total)\\Context Switches/sec']);
    });
}

function get_swap() {
    var plugin = client.plugin('swap', '');
    perfmon('\\Paging File(_Total)\\% Usage', function(err, data) {
        plugin.setGauge('percent', '', data.counters['\\Paging File(_Total)\\% Usage']);
    });
}

function start_monitoring() {
    get_cpu();
    setInterval(get_cpu, 10000);
    get_memory();
    setInterval(get_memory, 10000);
    get_df();
    setInterval(get_df, 10000);
    get_disk();
    get_interface();
    get_load();
    setInterval(get_load, 10000);
    get_uptime();
    setInterval(get_uptime, 60000);
    get_process();
    get_swap();

    get_perfmon.reInit();
    get_perfmon.reloadConfig(cfg.get('Plugin.perfmon'));
    get_perfmon.monitor();

}

function cw_config_write() {
    var failed = 0;
    var outputDir;
    var outputFilename;
    var hostname;
    var d = new Date();
    var oldFilename;
    var outputObj = {
        'HostnameCase': cfg.get('HostnameCase'),

        'HttpConfig': {
            'enable': cfg.get('HttpConfig.enable'),
            'listenPort': cfg.get('HttpConfig.listenPort'),
            'login': cfg.get('HttpConfig.login'),
            'password': cfg.get('HttpConfig.password'),
        }
    };
    if(cfg.has('Hostname')) {
        outputObj.Hostname = cfg.get('Hostname');
    }

    outputDir = configDir;
    hostname = os.hostname();
    hostname = hostname ? hostname.split('.')[0] : 'localhost';
    outputFilename = outputDir + '/' + hostname + '.json';
    oldFilename = outputFilename + '-' 
        + ('0'+d.getFullYear()).slice(-4)
        + ('0'+(d.getMonth()+1)).slice(-2)
        + ('0'+d.getDate()).slice(-2)
        + '_'
        + ('0'+d.getHours()).slice(-2)
        + ('0'+d.getMinutes()).slice(-2)
        + ('0'+d.getSeconds()).slice(-2)
        ;
    
    fs.rename(outputFilename, oldFilename, function(err) {
        fs.writeFile(outputFilename, JSON.stringify(outputObj), function(err) {
            if(err) failed = 1;
        });
    });
    return(failed);
}

function cw_config_update(newcfg) {
    if(newcfg) {
        cfg.util.extendDeep(cfg, newcfg);
    }
}

if(cfg.get('HttpConfig.enable')) {
    var app = express();
    app.use(bodyParser.urlencoded({extended: true}));
    
    app.use(basicAuth(function(credentials, req, res, next) {
        if (credentials.username != collectwHTTPUser || md5(credentials.password) != CollectwHTTPPassword) {
            res.statusCode = 401;
            res.json({error: 'Invalid credential'});
        } else { next(); }
    }, 'Please enter your credentials.'));
    
    app.all('*', function(req, res, next) {
      req.requireAuthorization(req, res, next);
    });
    
    app.get('/', function(req, res) {
        res.set('Content-Type', 'text/html');
        res.send(fs.readFileSync(path + '\\frontend\\index.html'));
    });
    
    app.get('/jquery-2.1.1.min.js', function(req, res) {
        res.set('Content-Type', 'application/javascript');
        res.send(fs.readFileSync(path + '\\frontend\\jquery-2.1.1.min.js'));
    });
    
    app.get('/collectw.css', function(req, res) {
        res.set('Content-Type', 'text/css');
        res.send(fs.readFileSync(path + '\\frontend\\collectw.css'));
    });
    
    app.get('/version', function(req, res) {
        res.set('Content-Type', 'application/json');
        res.json({ version: collectwVersion    });
    });
    
    app.get('/show_config', function(req, res) {
        res.set('Content-Type', 'application/json');
        res.json({ 'config': cfg });
    });
    
    app.get('/collectw_pid', function(req, res) {
        res.set('Content-Type', 'application/json');
        res.json({ collectw_pid: process.pid    });
    });
    
    app.get('/collectd_network', function(req, res) {
        var netconf = [];
        var servers = cfg.get('Network.servers') || [];
        for (var i in servers) {
            netconf[netconf.length] = { 'host': servers[i].hostname, 'port': servers[i].port };
        }
        
        res.set('Content-Type', 'application/json');
        res.json(netconf);
    });
    
    app.post('/process/stop', function(req, res) {
        res.set('Content-Type', 'application/json');
        process.exit();
    });
    
    app.get('/httpconfig/port', function(req, res) {
        res.set('Content-Type', 'application/json');
        res.json({ collectwHTTPPort: (cfg.get('HttpConfig.listenPort') || 25826) });
    });
    
    app.post('/httpconfig/port', function(req, res) {
        var port = 25826;
        res.set('Content-Type', 'application/json');
        if((typeof req.body.port != 'undefined') && (req.body.port !== '')) {
            port = parseInt(req.body.port);
            cw_config_update({ 'HttpConfig': {'listenPort' : port}});
            cw_config_write();
            res.json({message: 'Host and port updated. Will take effect on next start'});
        } else {
            res.json({error: 'Host and port not updated'});
        }
    });
    
    app.post('/httpconfig/account', function(req, res) {
        res.set('Content-Type', 'application/json');
        if(        typeof req.body.user != 'undefined'
            &&    typeof req.body.password != 'undefined' 
            &&    req.body.user !== ''
            &&    req.body.password !== ''
        ) {
            collectwHTTPUser = req.body.user;
            CollectwHTTPPassword = md5(req.body.password);
            cw_config_update({ 'HttpConfig': {'login' : collectwHTTPUser }});
            cw_config_update({ 'HttpConfig': {'password' : req.body.password}});
            cw_config_write();
            res.json({message: 'User and password updated'});
        } else {
            res.json({error: 'User and password not updated'});
        }
    });

    app.get('/plugin/perfmon/counters', function(req, res) {
        var i;
        var txt = '';
        var pc = get_perfmon.configShow();
        res.set('Content-Type', 'application/json');
        // Ugly thing cause a strange bug with res.send(...);
        for (i in pc) {
            if(pc[i].enable) {
                txt += ', ' + JSON.stringify(pc[i]);
            }
        }
        res.send('[' + txt.substr(1) + ']');
    });
    

    var server = app.listen(cfg.get('HttpConfig.listenPort') || 25826);
}


client = new Collectd(get_interval(), get_collectd_servers_and_ports(), 0, get_hostname_with_case());

start_monitoring();

// vim: set filetype=javascript fdm=marker sw=4 ts=4 et:
