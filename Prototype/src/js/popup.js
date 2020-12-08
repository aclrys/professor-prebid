// This script runs when the extension popup is activated.
var allBidsDf, allAuctionsDf, allSlotsDf, auctionBidDataDf;
var prebidConfig = {};
Chart.plugins.unregister(ChartDataLabels);

// allow us to curry functions
const pipe = (...fns) => x => fns.reduce((y, f) => f(y), x);



// We need to calculate the diffs from the timestamps for the timeline barchar 
// and it needs to be transposed to be in the correct format
function computeElementDiffs(m) {
	return m.map(a => a.map((n, i, a) => i ? n - a[i - 1] : 0 - n));
}
function transpose(arr) {
	return Object.keys(arr[0]).map(function (c) {
		return arr.map(function (r) {
			return r[c];
		});
	});
}

/**Chart Data**/
var overviewPageTimelineDataTemplate = {
  labels: [""],
  datasets: [{
    label: 'pre-auction',
    backgroundColor: [
      'rgba(200, 200, 200, 1)', 'rgba(200, 200, 200, 1)'
    ],
    borderWidth: 0
  }, {
    label: 'auction',
    backgroundColor: [
      'rgba(100, 100, 255, 1)', 'rgba(100, 100, 255, 1)'
    ],
    borderWidth: 0
  }, {
    label: 'ad server',
    backgroundColor: [
      'rgba(255, 255, 100, 1)', 'rgba(255, 255, 100, 1)'
    ],
    borderWidth: 0
  },
  {
    label: 'render',
    backgroundColor: [
      'rgba(200, 50, 50, 1)', 'rgba(200, 50, 50, 1)'
    ],
    borderWidth: 0
  }]
};

var bidderPageTimelineDataTemplate = {
	labels: [""],
	datasets: [{
	  label: 'pre-auction',
	  backgroundColor: Array(6).fill('rgba(200, 200, 200, .75)'),
	  borderWidth: 0
	},{
	  label: 'auction-init',
	  backgroundColor: Array(6).fill('rgba(100, 100, 255, .75)'),
	  borderWidth: 0
	},{
	  label: 'bid time',
	  backgroundColor: Array(6).fill('rgba(255, 255, 100, .75)'),
	  borderWidth: 0
	},{
	  label: 'post-auction wait',
	  backgroundColor: Array(6).fill('rgba(200, 50, 50, .75)'),
	  borderWidth: 0
	},{
	  label: 'ad server',
	  backgroundColor: Array(6).fill('rgba(150, 100, 150, .75)'),
	  borderWidth: 0
	},{
	  label: 'render',
	  backgroundColor: Array(6).fill('rgba(150, 150, 150, .75)'),
	  borderWidth: 0
	}]
  };
  

// For Debug
function displayTable(output, defaultOutput = 'n/a') {
	if (output.length) {
		if (console.table) {
			console.table(output);
		} else {
			for (var j = 0; j < output.length; j++) {
				console.log(output[j]);
			}
		}
	} else {
		console.warn(defaultOutput);
	}
}



chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
	let msg = JSON.parse(request);

	if (msg.type == 'GPT_VISIBILITY_EVENT') {
		let view = '';

		console.log('GPT_VISIBILITY_EVENT: ' + msg.obj);

		msg.obj.forEach(x => {
			console.log(x);
			view = view.concat('<div>' + x + '</div>');
		});

		document.getElementById('view').innerHTML = view;

		sendResponse({
			msg: 'GPT_VISIBILITY_EVENT_RESPONSE'
		});
	}
});

document.addEventListener('DOMContentLoaded', function () {
	var gResponse;

	// Inform content.js script that we just became active and it will
	// respond with any auction data that might be available

	chrome.storage.local.get(["PP_Enabled"], function (result) {
		isEnabled = result.PP_Enabled;
		let pp_switch = document.getElementById('pp_enabled_switch');
		pp_switch.checked = isEnabled;
	});

	document.getElementById('pp_enabled_switch').addEventListener('click', handleEnableButtonStateChange, false);

	getAllAuctionData(getOverviewTabContent);


}, false);


function sendMessage(evt, x) {
	let data = {
		type: evt,
		obj: x
	};

	chrome.tabs.query({
		currentWindow: true,
		active: true
	}, function (tabs) {
		chrome.tabs.sendMessage(tabs[0].id, JSON.stringify(data), function (response) {
			console.log('PP_POPUP: sentMessage(' + evt + ' ' + x + ')');
			console.log('PP_POPUP: received response(' + response + ')');

		});
	});
}

function handleEnableButtonStateChange(event) {

	let isEnabled = event.target.checked
	chrome.storage.local.set({ "PP_Enabled": isEnabled }, function () {
		console.log('Value is set to ' + isEnabled);
	});

	sendMessage('PROFESSOR_PREBID_ENABLED', { 'isEnabled': isEnabled });
}


function getAllAuctionData(showContentCB) {
	chrome.tabs.query({
		currentWindow: true,
		active: true
	}, function (tabs) {
		let data = {
			type: 'POPUP_ACTIVE',
			obj: ''
		};
		// When POPUP is activated, send message, "processResponse()" is a callback that the
		// content.js script populates in response. SO, content.js builds data structures but
		// doesn't do anything until popup activates'
		chrome.tabs.sendMessage(tabs[0].id, JSON.stringify(data), pipe(initialiseData, showContentCB));
	});
}

function updateAllAuctionData(showContentCB) {
	getAllAuctionData(showContentCB);
}


function initialiseData(response) {
	if (response) {
		console.log(response);
		let responseData = JSON.parse(response);
		if (responseData['dfs']) {
			allBidsDf = new dfjs.DataFrame(responseData['dfs']['allBids']);
			console.log('passed all bids df');
			displayTable(allBidsDf.toCollection());
			allAuctionsDf = new dfjs.DataFrame(responseData['dfs']['auction']);
			displayTable(allAuctionsDf.toCollection());
			allSlotsDf = new dfjs.DataFrame(responseData['dfs']['slots']);
			displayTable(allSlotsDf.toCollection());
			prebidConfig = JSON.parse(responseData['prebidConfig']);
		}

		// join auctions and slots
		let auctionData = allAuctionsDf.join(allSlotsDf, ['slotElementId', 'adUnitPath']);
		// join with bids and set global
		auctionBidDataDf = auctionData.join(allBidsDf.select('auction', 'adUnitPath', 'slotElementId', 'bidder', 'type', 'bidRequestTime', 'bidResponseTime', 'nonRenderedHighestCpm', 'rendered'), ['auction', 'adUnitPath'], 'inner', shouldDropDuplicates = false)
		// calculate the stats
		let res = auctionBidDataDf.groupBy('auction', 'adUnitPath').aggregate(g => [g.filter(r => r.get('type') == 'noBid').distinct('bidder').count(), g.filter(r => r.get('type') == 'bid').distinct('bidder').count(), g.distinct('adUnitPath').count(), g.distinct('bidder').count()]).rename('aggregation', 'bidStats');
		res = res.join(auctionData, ['auction', 'adUnitPath']);


		// collect all the data for the overview page : for each auction, for each slot, the number of ads, bidders etc & the timestamps for each phase of the auction
		return res;
	}
}

////////////////////////////////////
// Now create the page content
////////////////////////////////////
function getOverviewTabContent(overviewData) {
	function addStatsToPage(container, auctionId, atld) {
		let tableElement = document.createElement("table");
		var rowElement = document.createElement("tr");
		var tdElement = document.createElement("td");
		tdElement.setAttribute('colSpan', 2);
		let auctionBidders = atld.get('bidStats')
		let auctionElement = document.createElement("p");
		auctionElement.style.fontSize = "10px";
		auctionElement.style.color = "grey";
		auctionElement.innerText = "Auction - " + auctionId;
		tdElement.appendChild(auctionElement);
		rowElement.appendChild(tdElement);
		tdElement = document.createElement("td");
		let adUnitElement = document.createElement("p");
		adUnitElement.style.fontSize = "10px";
		adUnitElement.style.color = "grey";
		adUnitElement.innerText = "Ad Unit - " + atld.get('adUnitPath');
		tdElement.appendChild(adUnitElement);
		rowElement.appendChild(tdElement);
		tableElement.appendChild(rowElement);
		rowElement = document.createElement("tr");
		tdElement = document.createElement("td");
		let numberAdsElement = document.createElement("p");
		numberAdsElement.style.fontSize = "10px";
		numberAdsElement.style.color = "grey";
		numberAdsElement.innerText = "Ads detected - " + auctionBidders[2];
		tdElement.appendChild(numberAdsElement);
		rowElement.appendChild(tdElement);
		tdElement = document.createElement("td");
		let numberBiddersElement = document.createElement("p");
		numberBiddersElement.style.fontSize = "10px";
		numberBiddersElement.style.color = "grey";
		numberBiddersElement.innerText = "Number of bidders - " + auctionBidders[1];
		tdElement.appendChild(numberBiddersElement);
		rowElement.appendChild(tdElement);
		tdElement = document.createElement("td");
		let noBidRatioElement = document.createElement("p");
		noBidRatioElement.style.fontSize = "10px";
		noBidRatioElement.style.color = "grey";
		noBidRatioElement.innerText = "No bids ratio - " + auctionBidders[0] + "/" + auctionBidders[3];
		tdElement.appendChild(noBidRatioElement);
		rowElement.appendChild(tdElement);
		tableElement.appendChild(rowElement);
		container.appendChild(tableElement);
	}

	$('#overview-content').empty();
	$('#timeline-container').empty();
	overviewContentContainerElement = document.getElementById('overview-content');
	// for each auction
	function addAuctionCard(auctionData) {

        let auctionId = auctionData.getRow(0).get('auction')
		auctionData.map(row => addStatsToPage(overviewContentContainerElement, auctionId, row));
		// for debug
		let auctionContent = auctionData.toArray().reduce((p, n) => p + n.join('\t') + '\n', '');
		console.log(auctionContent);
		let auctionContentEl = document.createElement('p');
		auctionContentEl.innerText = auctionContent;
		overviewContentContainerElement.appendChild(auctionContentEl);

		let timelineData = auctionData.select('preAuctionStartTime', 'startTime', 'endTime', 'slotRenderedTs', 'slotLoadTs').toArray();
		// TODO for mult auctions we need to insert a first el which is the time from the earliest auc start to this auc
		if (timelineData.length > 0) {
			timelineData = transpose(computeElementDiffs(timelineData)).slice(1);
			console.log(timelineData);
		}

		let overviewPageTimelineData = $.extend( true, {}, overviewPageTimelineDataTemplate );
		overviewPageTimelineData.labels = auctionData.distinct('adUnitPath').toArray();
		for (var i = 0; i < 4; i++) {
			overviewPageTimelineData.datasets[i].data = timelineData[i];
		}

		Chart.plugins.unregister(ChartDataLabels);
		let timelineContainer = document.getElementById('timeline-container');
		let canvasElement = document.createElement('canvas');
		canvasElement.style.width = '800px';
		canvasElement.style.height = '75px';
		timelineContainer.appendChild(canvasElement);


		var myBarChart1 = new Chart(canvasElement, {
			type: 'horizontalBar',
			data: overviewPageTimelineData,
			plugins: [ChartDataLabels],
			options: options
		});
	}
	overviewData.groupBy('auction', 'adUnitPath').aggregate(group => addAuctionCard(group))
}




function updateBidderStatisticsContent(allBidders, selectedAdUnit) {
	// get avg cpm and time for each bidder
	// for all auctions but optionally for a selected ad unit
	// display in a carousel

	$('#bidder-stats-container').empty();
	bidderStatsContainerElement = document.getElementById('bidder-stats-container');
	bidderStatsContentElement = document.createElement('div');
	bidderStatsContentElement.class = 'bidder-stats-content';
	bidderStatsContentElement.id = 'bidder-stats-content';
	bidderStatsContainerElement.appendChild(bidderStatsContentElement);

	function addCard(container, bidder, cpm, time) {
		const cardDiv = document.createElement('div');
		const tab = document.createElement('table');
		tab.id = 'table-bidder-stats-card';
		cardDiv.appendChild(tab);
	
		let r = tab.insertRow(-1);
		r.style = "background-color:yellow";
		let c = r.insertCell(0);
		c.innerHTML = 'Bidder ' + bidder;

		r = tab.insertRow(-1);
		r.style = "background-color:lightgrey";

		c = r.insertCell(0);
		c.innerHTML = 'Avg Bid CPM<br/>' + cpm + '$';

		r = tab.insertRow(-1);
		r.style = "background-color:lightgrey";

		c = r.insertCell(0);
		c.innerHTML = 'Avg Response Time<br/>' + time + 'ms';;

		container.appendChild(cardDiv);
	}


	if (selectedAdUnit != 'all') {
		allBidders = allBidders.filter(r => r.get('adUnitPath') == selectedAdUnit)
	}

	let bidderDf = allBidders.groupBy('bidder').aggregate(bidderGroup => ({cpm:bidderGroup.stat.mean('cpm'), 'time':bidderGroup.stat.mean('time')}));
	bidderDf.map(r => addCard(bidderStatsContentElement, r.get('bidder'), r.get('aggregation').cpm, r.get('aggregation').time));

	// TODO get all these behind a debug flag
	displayTable(bidderDf.toArray());


	$('#bidder-stats-content').slick({
		arrows: true,
		dots: true,
		slidesToShow: 4,
		slidesToScroll: 4,
		infinite: true,
		cssEase: 'linear',
		dotsClass: 'slick-dots'
	}); 
}

function getBidderStatisticsContent() {
		// get list of ad units
		let allBidders = allBidsDf.filter(r => r.get('type') == 'bid').sortBy('cpm', true)
		let adUnits = ['all'].concat(allBidders.distinct('adUnitPath').toArray())
		$('#bidder-stats-adunit-selector').empty();
		adUnits.map(au => $('#bidder-stats-adunit-selector').append(new Option(au, au)));

		$('#bidder-stats-adunit-selector').on('change', function() {
			let adunit = $(this).val();
			updateBidderStatisticsContent(allBidders, adunit);
		});

		updateBidderStatisticsContent(allBidders, 'all');	
}


function updateBidderTimelineContent(auctionId, adUnitPath) {

	function collectAuctionBidderData(groupedBidders, auctionId, adUnitPath) {

		function collectAuctionBidderSlotData(group) {

			res =  auctionId != 'all' ? group.filter(r => r.get('auction') == auctionId) : group;
			if (adUnitPath != 'all') {
				res = res.filter(r => r.get('adUnitPath') == adUnitPath);
				res = res.groupBy('auction', 'bidder').aggregate(g => ({'cpm' : g.stat.mean('cpm'), 'bidderStart' : g.stat.mean('bidRequestTime'), 'bidderEnd' : g.stat.mean('bidResponseTime')})).rename('aggregation', 'bidStats');
				res = res.withColumn('adUnitPath', () => adUnitPath);
			} else {
				res = res.groupBy('auction', 'adUnitPath', 'bidder').aggregate(g => ({'cpm' : g.stat.mean('cpm'), 'bidderStart' : g.stat.mean('bidRequestTime'), 'bidderEnd' : g.stat.mean('bidResponseTime')})).rename('aggregation', 'bidStats');
			}
			res = res.join(auctionBidDataDf, ['auction', 'adUnitPath', 'bidder']);
			return res.sortBy(['startTime', 'bidResponseTime']);
		}
		// for each auction process the set of bids
		return groupedBidders.aggregate(g => collectAuctionBidderSlotData(g))
	}
	// collect all the data for the bidder timeline page : for each auction, bidder, possibly filtered by slot
	// for each return the number of ads, bidders etc & the timestamps for each phase of the auction
	let allBidders = allBidsDf.filter(r => r.get('type') == 'bid')
	return collectAuctionBidderData(allBidders.groupBy('auction'), auctionId, adUnitPath);
}


function updateTimelinePageContent(atld) {
	
	// for each auction
	function addTimeline(auctionId, auctionData) {

		let timelineData = auctionData.select('preAuctionStartTime', 'startTime', 'bidRequestTime', 'bidResponseTime', 'endTime', 'slotRenderedTs', 'slotLoadTs').toArray();
		if (timelineData.length > 0) {
			timelineData = transpose(computeElementDiffs(timelineData)).slice(1);
			console.log(timelineData);

			let bidderPageTimelineData = $.extend( true, {}, bidderPageTimelineDataTemplate );
			bidderPageTimelineData.labels = auctionData.select('bidder').toArray();
			for (var i = 0; i < 6; i++) {
				bidderPageTimelineData.datasets[i].data = timelineData[i];
				bidderPageTimelineData.datasets[i].backgroundColor  = Array(bidderPageTimelineData.labels.length).fill(bidderPageTimelineData.datasets[i].backgroundColor[0]);
			}
			let winner = auctionData.findWithIndex(r => r.get('rendered') == true)
			if (winner) {
				for(i=0; i<6; i++) {
					bidderPageTimelineData.datasets[i].borderWidth = Array(bidderPageTimelineData.labels.length).fill(0);	
					bidderPageTimelineData.datasets[i].borderWidth[winner.index] = 2; 
					bidderPageTimelineData.datasets[i].borderColor = Array(bidderPageTimelineData.labels.length).fill('black')
					bidderPageTimelineData.datasets[i].borderColor[winner.index] = 'rgba(255, 0, 0, 1)'
					bidderPageTimelineData.datasets[i].backgroundColor[winner.index] = bidderPageTimelineData.datasets[i].backgroundColor[winner.index].replace(/[^,]+(?=\))/, '1')
				}
			}

			let timelineContainer = document.getElementById('bidder-timeline-container');
			let auctionHeader = document.createElement('div');
			auctionHeader.innerHTML='<p>Auction ' + auctionId + '</p>'
			let canvasElement = document.createElement('canvas');
			canvasElement.style.width = '800px';
			timelineContainer.appendChild(auctionHeader);
			timelineContainer.appendChild(canvasElement);

			new Chart(canvasElement, {
				type: 'horizontalBar',
				data: bidderPageTimelineData,
				plugins: [ChartDataLabels],
				options: options
			});
		}
	}

	$('#bidder-timeline-content').empty();
	$('#bidder-timeline-container').empty();
    atld.map(auction => addTimeline(auction.get('auction'), auction.get('aggregation')));

}

function getBidderTimelineContent() {
	// get list of ad units
	let allBidders = allBidsDf.filter(r => r.get('type') == 'bid').sortBy('cpm', true)
	let adUnits = ['all'].concat(allBidders.distinct('adUnitPath').toArray())
	let auctions  = ['all'].concat(allBidders.distinct('auction').toArray())

	$('#bidder-timeline-auction-selector').empty();
	$('#bidder-timeline-adunit-selector').empty();
	auctions.map(a => $('#bidder-timeline-auction-selector').append(new Option(a, a)));
	adUnits.map(au => $('#bidder-timeline-adunit-selector').append(new Option(au, au)));

	let atld = undefined;
	$('#bidder-timeline-auction-selector').on('change', function() {
		let auction = $(this).val();
		atld = updateBidderTimelineContent(auction, $('#bidder-timeline-adunit-selector').val());
		updateTimelinePageContent(atld);
	});

	$('#bidder-timeline-adunit-selector').on('change', function() {
		let adunit = $(this).val();
		atld = updateBidderTimelineContent($('#bidder-timeline-auction-selector').val(), adunit);
		updateTimelinePageContent(atld);
	});

	atld = updateBidderTimelineContent('all', 'all');	
	// now update the page
	updateTimelinePageContent(atld);
}
 

function getPrebidConfig() {
	$('#prebid-config-container').empty();
	let prebidConfigElement = document.createElement('div');
	let pre = document.createElement('pre');
	pre.innerHTML = JSON.stringify(prebidConfig, undefined, 2);
	prebidConfigElement.appendChild(pre);
	let configContainer = document.getElementById('prebid-config-container');
	configContainer.appendChild(prebidConfigElement);
	// TODO jquery not working???
	// $('#prebid-config-container').add(prebidConfigElement);
}

function displayTabContent(tab) {
	switch (tab) {
		case 0: updateAllAuctionData(getOverviewTabContent); // will update/set auctionTimelineData
			break;
		case 1: getBidderStatisticsContent();
			break;
		case 2: getBidderTimelineContent();
			break;
		case 3: getPrebidConfig();
			break;
		default: console.log('not implemented yet. tab ' + tab);
	}
}











// ***********************************************
// * OLD
// Some of the below might be useful



function convertTimestamp(requestTimestamp) {
	let ts = new Date(requestTimestamp);
	let h = ts.getHours();
	let m = ts.getMinutes();
	let s = ts.getSeconds();
	let ms = ts.getMilliseconds();

	if (h < 10) {
		h = '0' + h
	}
	if (m < 10) {
		m = '0' + m
	}
	if (s < 10) {
		s = '0' + s
	}

	return (`${h}:${m}:${s}.${ms}`);
}

// This method populated the 3 tabs in the popup. I'm sure there is a much better way
// to build the popup HTML using jquery. This works but hardly elegant nor flexible.

function processResponse(response) {
	gResponse = response;

	var auctionDiv = document.getElementById('auctionDiv');
	var requestDiv = document.getElementById('requestDiv');
	var gptDiv = document.getElementById('gptDiv');

	// Auction Tab

	var tableNumber = 1;
	var tabId = null;

	for (let [auctionId, auctionData] of Object.entries(JSON.parse(response.auction))) {
		console.log('auctionId=' + auctionId);

		const hr = document.createElement('hr');

		let adUnitObj = auctionData.adUnitObj;

		const auctionHeading = document.createElement('div');
		auctionHeading.style = "font-weight:bold";
		auctionHeading.textContent = `AuctionTime: ${auctionData.auctionTimestamp} AuctionID: ${auctionId}`;
		auctionDiv.appendChild(hr);
		auctionDiv.appendChild(auctionHeading);

		for (let [adUnit, value1] of Object.entries(adUnitObj)) {
			console.log('adUnit=' + adUnit);
			console.log(value1);

			const adUnitHeading = document.createElement('div');
			adUnitHeading.style = "font-weight:bold";
			adUnitHeading.textContent = `AdUnitName: ${adUnit}`;
			auctionDiv.appendChild(adUnitHeading);

			const slotHeading = document.createElement('div');
			slotHeading.style = "font-weight:bold";
			let slot = auctionData.adUnitMapToSlot[adUnit];
			slotHeading.textContent = `AdUnitPath: ${slot}`;
			auctionDiv.appendChild(slotHeading);

			const tab = document.createElement('table');
			tab.id = 'table_' + tableNumber;
			auctionDiv.appendChild(tab);

			let r = tab.insertRow(0);
			r.style = "background-color:yellow";

			let c = r.insertCell(0);
			c.innerHTML = 'Bidder';

			c = r.insertCell(1);
			c.innerHTML = 'RequestTimestamp';

			c = r.insertCell(2);
			c.innerHTML = 'TimeToRespond';

			c = r.insertCell(3);
			c.innerHTML = 'Size';

			c = r.insertCell(4);
			c.innerHTML = 'CPM';

			var rowNumber = 1;
			value1.forEach(e => {
				let r = tab.insertRow(rowNumber);
				r.style = "background-color:gainsboro";

				let c = r.insertCell(0);
				c.innerHTML = `${e.bidder}`;

				c = r.insertCell(1);
				if (typeof e.requestTimestamp !== 'undefined') {
					c.innerHTML = convertTimestamp(e.requestTimestamp);
				} else {
					c.innerHTML = "-";
				}

				c = r.insertCell(2);
				if (typeof e.timeToRespond !== 'undefined') {
					c.innerHTML = `${e.timeToRespond}`;
				} else {
					c.innerHTML = "-";
				}

				c = r.insertCell(3);
				if (typeof e.size !== 'undefined') {
					c.innerHTML = `${e.size}`;
				} else {
					c.innerHTML = "-";
				}

				c = r.insertCell(4);
				if (typeof e.cpm !== 'undefined') {
					c.innerHTML = `${e.cpm.toFixed(2)}`;
				} else {
					c.innerHTML = "-";
				}

				rowNumber++;
			});
		}
	}

	// REQUEST Tab

	// This is just a SAMPLE of data that can be displayed, there is lots more in the data structure

	for (let [auctionId, info] of Object.entries(JSON.parse(response.bidrequested))) {
		const hr = document.createElement('hr');

		requestDiv.appendChild(hr);

		let requestHeading = document.createElement('div');
		requestHeading.style = "font-weight:bold";
		requestHeading.textContent = `AuctionID: ${info.auctionId}`;
		requestDiv.appendChild(requestHeading);

		requestHeading = document.createElement('div');
		requestHeading.style = "font-weight:bold";
		requestHeading.textContent = `Bidder: ${info.bidderCode}`;
		requestDiv.appendChild(requestHeading);

		if (typeof info.gdprConsent !== 'undefined') {
			requestHeading = document.createElement('div');
			requestHeading.textContent = `Gdpr Consent String: ${info.gdprConsent.consentString}`;
			requestDiv.appendChild(requestHeading);

			requestHeading = document.createElement('div');
			requestHeading.textContent = `Gdpr Vendor Data Metadata: ${info.gdprConsent.vendorData.metadata}`;
			requestDiv.appendChild(requestHeading);

			requestHeading = document.createElement('div');
			requestHeading.textContent = `Gdpr gdprApplies: ${info.gdprConsent.vendorData.gdprApplies}`;
			requestDiv.appendChild(requestHeading);

			requestHeading = document.createElement('div');
			requestHeading.textContent = `Gdpr hasGlobalScope: ${info.gdprConsent.vendorData.hasGlobalScope}`;
			requestDiv.appendChild(requestHeading);
		} else if (typeof info.uspConsent !== 'undefined') {
			requestHeading = document.createElement('div');
			requestHeading.textContent = `uspConsent: ${info.uspConsent}`;
			requestDiv.appendChild(requestHeading);
		}
	}

	// GPT Tab

	// This is just a SAMPLE of data that can be displayed, there is lots more in the data structure

	function treeListener(idx) {
		var node = document.getElementById('myUL' + idx);
		var toggler = node.getElementsByClassName("caret");
		var i;

		toggler[0].addEventListener("click", function () {
			this.parentElement.querySelector(".nested").classList.toggle("active");
			this.classList.toggle("caret-down");
		});
	}

	var i = 0;
	for (let [slot, info] of Object.entries(JSON.parse(response.gpt))) {
		const hr = document.createElement('hr');

		let gptAdUnitPath = info.adUnitPath;
		let gptSlotElementId = info.slotElementId;

		gptDiv.appendChild(hr);
		let gptButton = document.createElement('button');
		gptButton.innerHTML = "Press To Highlight Ad Slot";
		gptButton.id = gptSlotElementId;
		gptDiv.appendChild(gptButton);
		document.getElementById(gptSlotElementId).addEventListener('click', onclickGptButton, false)

		let gptHeading = document.createElement('div');
		gptHeading.style = "font-weight:bold";
		gptHeading.textContent = `${gptAdUnitPath}`;
		gptDiv.appendChild(gptHeading);

		gptHeading = document.createElement('div');
		gptHeading.style = "font-weight:bold";
		gptHeading.textContent = `${gptSlotElementId}`;
		gptDiv.appendChild(gptHeading);

		let ul0 = document.createElement('ul');
		let ul1 = document.createElement('ul');
		let il = document.createElement('il');
		let span = document.createElement('span');

		ul0.id = "myUL" + i;
		ul1.className = "nested";
		span.className = "caret";
		span.innerHTML = "Targeting KV Pairs";

		gptDiv.appendChild(ul0);
		ul0.appendChild(il);
		il.appendChild(span);
		il.appendChild(ul1);

		for (let [k, v] of Object.entries(info.gptTargeting)) {
			let li = document.createElement('li');
			li.innerHTML = `${k} = ${v}`;
			ul1.appendChild(li);
		}

		treeListener(i);

		i++;
	}
};

function onclickGptButton(event) {
	if (gResponse !== 'undefined') {
		let data = {
			target: event.target.id,
			nottarget: []
		};

		for (let [slot, info] of Object.entries(JSON.parse(gResponse.gpt))) {
			if (info.slotElementId !== event.target.id) {
				data.nottarget.push(info.slotElementId);
			}
		}

		sendMessage('POPUP_GPTBUTTON', data);
	} else {
		console.log('gResponse is undefined');
	}
}

function onclickAuction() {
	var i, tabcontent, tablinks;

	tabcontent = document.getElementsByClassName("tabcontent");
	for (i = 0; i < tabcontent.length; i++) {
		tabcontent[i].style.display = "none";
	}

	tablinks = document.getElementsByClassName("tablinks");
	for (i = 0; i < tablinks.length; i++) {
		tablinks[i].className = tablinks[i].className.replace(" active", "");
	}

	document.getElementById('auctionDiv').style.display = "block";
	event.currentTarget.className += " active";
}

function onclickRequest() {
	var i, tabcontent, tablinks;

	tabcontent = document.getElementsByClassName("tabcontent");
	for (i = 0; i < tabcontent.length; i++) {
		tabcontent[i].style.display = "none";
	}

	tablinks = document.getElementsByClassName("tablinks");
	for (i = 0; i < tablinks.length; i++) {
		tablinks[i].className = tablinks[i].className.replace(" active", "");
	}

	document.getElementById('requestDiv').style.display = "block";
	event.currentTarget.className += " active";
}

function onclickGpt() {
	var i, tabcontent, tablinks;

	tabcontent = document.getElementsByClassName("tabcontent");
	for (i = 0; i < tabcontent.length; i++) {
		tabcontent[i].style.display = "none";
	}

	tablinks = document.getElementsByClassName("tablinks");
	for (i = 0; i < tablinks.length; i++) {
		tablinks[i].className = tablinks[i].className.replace(" active", "");
	}

	document.getElementById('gptDiv').style.display = "block";
	event.currentTarget.className += " active";
}




