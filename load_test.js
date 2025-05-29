import http from 'k6/http';
import { sleep, check } from 'k6';
export let options = {
    vus: 500,
    duration: '1s',
    thresholds: {
        http_req_duration: ['p(95)<1000'],
    },
};
export default function () {
    const urls = [
        'http://localhost:3001',
        'http://localhost:3003/api/warehouse-inventory',
        'http://localhost:3003/api/production-orders',
        'http://localhost:3003/api/material-costs',
    ];
    let url = urls[Math.floor(Math.random() * urls.length)];
    let res = http.get(url);
    check(res, {
        'status is 2хх': (r) => r.status >= 200 && r.status < 300,
    });
    sleep(1);
}